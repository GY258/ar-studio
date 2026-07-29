/**
 * L2 · 渲染回归。
 *
 * 断网、无摄像头、无 GPU、不加载 MediaPipe。fixture 和 golden 都在仓库里。
 * 如果这个测试需要访问 @mediapipe 的 WASM 或模型文件，说明 provider 抽得不干净。
 *
 * 每个有元素的模板三条断言：
 *   t = 0    与 golden 一致（整帧差异 / 掩膜 IoU / 中心偏移 / ΔE00 四个指标）
 *   t = P/4  与 t0 必须有差异（证明动画真的在动，不是画了一张静态图）
 *   t = P    与 t0 差异 ≈ 0（周期闭合。相位算错了就闭不上）
 *
 * golden 用 --update-golden 生成，人工过目后提交。CI 里不生成 golden。
 */

import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import type { PNG } from "pngjs";
import { expandGenerators } from "../src/engine/generators";
import { applyEase, evaluateAnimations } from "../src/engine/animations";
import { migrateElements } from "../src/lib/migrate";
import {
  launchHarness,
  loadTemplate,
  switchTemplate,
  capture,
  templatePeriod,
  type FixtureName,
  type Harness,
} from "../scripts/harness-driver";
import {
  decode,
  diffRatio,
  diffImage,
  maskIoU,
  maskCentroid,
  coverage,
  meanColor,
  deltaE00,
  localVariance,
  panelArea,
} from "./image-metrics";

const ROOT = process.cwd();
const TEMPLATES = path.join(ROOT, "src/content/templates");
const GOLDEN = path.join(ROOT, "test/golden");
const ARTIFACTS = path.join(ROOT, "test/.artifacts");

const UPDATE = process.argv.includes("--update-golden") || process.env.UPDATE_GOLDEN === "1";

/** 验收阈值，沿用滤镜规范一/二辑。 */
const IOU_MIN = 0.85;
const CENTER_MAX = 0.015; // 1.5% W
const DELTA_E_MAX = 8;
const DIFF_MAX = 0.01; // 1% 像素
/** 周期闭合允许的残差。抗锯齿抖动比这个小一个量级。 */
const CLOSURE_MAX = 0.002;
/**
 * 「动画在动」至少要有这么多像素变化。
 * 阈值压得低是因为 float 的振幅只有 0.4%H（两三个像素），
 * 一个 50px 宽的贴纸挪两像素也就百来个像素变色。
 */
const MOTION_MIN = 0.0001;

/**
 * 框内的高频能量：相邻像素亮度差的均值。
 *
 * 「细节被抹掉了没有」不能用「和原帧相同的像素比例」来量 —— 那个判据是按合成
 * fixture 的高对比棋盘格调的。真实照片本身就低对比，一个马赛克块内的像素本来
 * 就都在块均值 ±6 以内，于是「相同比例」永远很高，断言变成在验背景有多平。
 *
 * 高频能量直接对应「细节」：马赛克和模糊都会把块内/邻域内的差异抹平，
 * 只在块边界留下跳变，整体能量必然大幅下降。灰度化则不影响它 —— 正好，
 * 那条该验的是彩度。
 */
function highFreq(p: PNG, x0: number, y0: number, w: number, h: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w - 1; x++) {
      const a = (y * p.width + x) << 2;
      const b = a + 4;
      const la = 0.2126 * p.data[a] + 0.7152 * p.data[a + 1] + 0.0722 * p.data[a + 2];
      const lb = 0.2126 * p.data[b] + 0.7152 * p.data[b + 1] + 0.0722 * p.data[b + 2];
      sum += Math.abs(la - lb);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** 展开后有没有动画。静态模板不该被「动画在动」那条断言卡住。 */
function hasAnimations(templatePath: string): boolean {
  const raw = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  return migrateElements(raw).elements.some((e) => (e.animations?.length ?? 0) > 0);
}

/**
 * 有元素的模板才需要渲染回归；particle 模板走的是另一条线，本轮不碰。
 *
 * 「有元素」要看数组长度，不能只看字段在不在：只有帧效果的模板（colorful-me）
 * 写的是 `elements: []`，字段存在但一个元素都没有，进了这条回归会卡在
 * 「展开后应该有元素」上，而它根本就不该有元素。
 */
function templatesWithElements(): string[] {
  return fs
    .readdirSync(TEMPLATES)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES, f), "utf8"));
      const els = raw.elements ?? raw.overlay_elements ?? raw.face_track_elements;
      return Array.isArray(els) && els.length > 0;
    })
    .sort();
}

let harness: Harness;

test.beforeAll(async () => {
  harness = await launchHarness();
  fs.mkdirSync(GOLDEN, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
});

test.afterAll(async () => {
  await harness?.close();
});

/** 只有 fixture 图、没有任何元素的一帧，做元素掩膜的底图。 */
async function baseFrame(fixture: FixtureName) {
  const empty = path.join(ARTIFACTS, `__base-${fixture}.json`);
  fs.writeFileSync(
    empty,
    JSON.stringify({
      slug: `base-${fixture}`,
      name: { zh: "空" },
      category: "test",
      price_cents: 0,
      template_type: "overlay",
      perception: [],
      elements: [],
    }),
  );
  await loadTemplate(harness.page, empty, fixture);
  return decode(await capture(harness.page, 0));
}

for (const file of templatesWithElements()) {
  const slug = path.basename(file, ".json");
  const templatePath = path.join(TEMPLATES, file);

  test(`${slug} · 渲染回归`, async () => {
    const { period: P, closes } = templatePeriod(templatePath);
    const count = await loadTemplate(harness.page, templatePath, "front");
    expect(count, "展开后应该有元素").toBeGreaterThan(0);

    const t0 = decode(await capture(harness.page, 0));
    // 探针取 P/4 而不是 P/2：float 和 pulse 都是正弦，半周期正好又回到起点，
    // 用 P/2 会把「动画在动」误判成「没动」。P/4 是正弦的峰值。
    const tQuarter = decode(await capture(harness.page, P / 4));
    const tFull = decode(await capture(harness.page, P));

    const goldenPath = path.join(GOLDEN, `${slug}-t0.png`);

    if (UPDATE || !fs.existsSync(goldenPath)) {
      fs.writeFileSync(goldenPath, await capture(harness.page, 0));
      test.info().annotations.push({ type: "golden", description: `已写入 ${slug}-t0.png，请人工过目后提交` });
    }

    // --- t=0 对 golden ---
    const golden = decode(fs.readFileSync(goldenPath));
    const ratio = diffRatio(t0, golden);
    if (ratio > DIFF_MAX) {
      fs.writeFileSync(path.join(ARTIFACTS, `${slug}-diff.png`), diffImage(t0, golden));
    }
    expect(ratio, `整帧差异像素比例（差异图见 test/.artifacts/${slug}-diff.png）`).toBeLessThanOrEqual(DIFF_MAX);

    const base = await baseFrame("front");
    // baseFrame 换过模板，要把待测模板装回来
    await loadTemplate(harness.page, templatePath, "front");

    expect(maskIoU(t0, golden, base), "元素掩膜 IoU").toBeGreaterThanOrEqual(IOU_MIN);

    const cNow = maskCentroid(t0, base);
    const cGold = maskCentroid(golden, base);
    expect(cNow && cGold, "两帧都应该有元素").toBeTruthy();
    expect(Math.hypot(cNow!.x - cGold!.x, cNow!.y - cGold!.y), "元素包围盒中心偏移 /W").toBeLessThanOrEqual(
      CENTER_MAX,
    );

    const px = Math.round(cNow!.x * t0.width);
    const py = Math.round(cNow!.y * t0.width);
    expect(deltaE00(meanColor(t0, px, py), meanColor(golden, px, py)), "元素中心 5x5 均值色 ΔE00").toBeLessThanOrEqual(
      DELTA_E_MAX,
    );

    // --- 渲染非空：防「校验过了但什么都看不见」 ---
    expect(coverage(t0, base), "元素覆盖的像素比例").toBeGreaterThan(0.001);

    // --- 动画确实在动 ---
    // 没有任何动画的模板是合法的（lowres-life 就是一块静态假 UI），
    // 对它断言「必须有差异」永远会红。显式跳过并记一笔，不要默默放过。
    if (hasAnimations(templatePath)) {
      expect(diffRatio(t0, tQuarter, 0.05), `t=0 与 t=P/4（P=${P}s）应该有差异`).toBeGreaterThan(MOTION_MIN);
    } else {
      test.info().annotations.push({
        type: "skipped-assertion",
        description: `${slug}: 模板没有声明任何动画，跳过「动画在动」和「周期闭合」两条断言`,
      });
      return;
    }

    // --- 周期闭合：相位算对了才闭得上 ---
    if (closes) {
      expect(diffRatio(t0, tFull, 0.05), `t=0 与 t=P（P=${P}s）应该几乎重合`).toBeLessThanOrEqual(CLOSURE_MAX);
    } else {
      // 各元素 period 两两互质，不存在可用的公共周期。挑一个数字假装闭合
      // 只会得到一条永远红或永远无意义的断言，所以显式跳过并说明。
      test.info().annotations.push({
        type: "skipped-assertion",
        description: `${slug}: 各动画 period 无公共周期，跳过「周期闭合」断言（最长 period ${P}s）`,
      });
    }
  });
}

test("丢脸兜底：face 模板在 noface 下不崩溃，screen 元素仍显示", async () => {
  const crying = path.join(TEMPLATES, "crying.json");
  await loadTemplate(harness.page, crying, "noface");
  const frame = decode(await capture(harness.page, 0));
  const base = await baseFrame("noface");
  await loadTemplate(harness.page, crying, "noface");

  // (T_T) 是 screen 空间的，没有人脸也该画出来；眼泪是 face 空间的，应该消失
  const cov = coverage(frame, base);
  expect(cov, "screen 空间元素在没有人脸时仍应显示").toBeGreaterThan(0.001);
  expect(cov, "face 空间元素应该已经隐藏，覆盖率不该和有脸时一样高").toBeLessThan(0.05);
});

test("lowres-life：蒙版内与原帧逐像素相同，蒙版外被真正抹掉细节", async () => {
  const tpl = path.join(TEMPLATES, "lowres-life.json");
  await loadTemplate(harness.page, tpl, "front");
  const frame = decode(await capture(harness.page, 0));
  const base = await baseFrame("front");

  // 直接比像素，不用局部方差。方差是间接指标：人脸轮廓本身就是强边缘，
  // 打了码方差照样高；反过来大片纯色打了码方差也不降。
  const W = frame.width;
  const H = frame.height;
  const same = (x: number, y: number) => {
    const o = (y * W + x) << 2;
    return (
      Math.abs(frame.data[o] - base.data[o]) +
        Math.abs(frame.data[o + 1] - base.data[o + 1]) +
        Math.abs(frame.data[o + 2] - base.data[o + 2]) <=
      6
    );
  };
  const ratioIn = (x0: number, y0: number, w: number, h: number) => {
    let n = 0;
    let t = 0;
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        if (same(x, y)) n++;
        t++;
      }
    return n / t;
  };

  // 人身上（蒙版内）：应该原样保留。坐标按 front fixture 实测的人体范围取，
  // 换 fixture 时要跟着重新对位 —— 采样框落到背景上的话这条断言会静默变成永远通过
  expect(ratioIn((W * 0.52) | 0, (H * 0.39) | 0, 60, 60), "蒙版内应与原帧逐像素相同").toBeGreaterThan(0.97);
  /*
   * 背景（蒙版外）的细节应该被抹掉。
   *
   * 取样框落在**有花纹**的背景上（按亮度方差扫出来的格栅那一带，避开右下角的
   * 画质菜单）：取到平墙上的话，打不打码都一样，断言就变成在验墙有多平。
   */
  const bx = (W * 0.854) | 0;
  const by = (H * 0.13) | 0;
  const before = highFreq(base, bx, by, 120, 120);
  const after = highFreq(frame, bx, by, 120, 120);
  expect(after / before, `蒙版外的高频能量应该被马赛克抹掉（${before.toFixed(1)} → ${after.toFixed(1)}）`).toBeLessThan(
    0.5,
  );
});

/**
 * 帧效果必须真的作用。
 *
 * 这条挡的是一类静默失效：`blur` 曾经能过校验、能正常渲染、什么效果都没有、
 * 也不报任何错 —— 校验器认识的 kind 和引擎实现了的 kind 是两份各写各的名单。
 * 对 LLM 生成模板尤其致命：全套 gate 绿灯放行，产出一个「没效果」的模板。
 * 所以每加一个 kind 都要在这里加一行，证明它确实改变了画面。
 */
for (const [kind, effect] of [
  ["blur", { kind: "blur", radius: 0.02 }],
  ["desaturate", { kind: "desaturate", amount: 1 }],
] as const) {
  test(`帧效果 ${kind}：蒙版外真的变了，蒙版内逐像素不变`, async () => {
    const file = path.join(ARTIFACTS, `__effect-${kind}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        slug: `effect-${kind}`,
        name: { zh: "帧效果" },
        category: "test",
        price_cents: 0,
        template_type: "overlay",
        perception: ["segmentation"],
        source: {
          mask: { provider: "person", feather: 0.015, onLost: "clear" },
          apply: "outside",
          effect,
        },
        elements: [],
      }),
    );
    await loadTemplate(harness.page, file, "front");
    const frame = decode(await capture(harness.page, 0));
    const base = await baseFrame("front");

    const W = frame.width;
    const H = frame.height;
    const stats = (x0: number, y0: number, w: number, h: number) => {
      let same = 0;
      let total = 0;
      let chroma = 0;
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const o = (y * W + x) << 2;
          const [r, g, b] = [frame.data[o], frame.data[o + 1], frame.data[o + 2]];
          if (
            Math.abs(r - base.data[o]) + Math.abs(g - base.data[o + 1]) + Math.abs(b - base.data[o + 2]) <= 6
          ) {
            same++;
          }
          chroma += Math.max(r, g, b) - Math.min(r, g, b);
          total++;
        }
      }
      return { sameRatio: same / total, chroma: chroma / total };
    };

    // 人身上（蒙版内）：apply "outside" 不该动它
    expect(stats((W * 0.52) | 0, (H * 0.39) | 0, 60, 60).sameRatio, "蒙版内应与原帧逐像素相同").toBeGreaterThan(
      0.97,
    );
    /*
     * 背景（蒙版外）：效果必须真的落下去。两种效果得用各自对得上的判据 ——
     * blur 抹的是细节（高频能量），desaturate 抹的是彩度，
     * 拿一个通用的「像素变了多少」去量两者，在低对比的真实照片上都会失灵。
     * 取样框同样落在有花纹的地方，理由见 lowres-life 那条。
     */
    const bx = (W * 0.854) | 0;
    const by = (H * 0.13) | 0;
    const outside = stats(bx, by, 120, 120);
    if (kind === "blur") {
      const before = highFreq(base, bx, by, 120, 120);
      const after = highFreq(frame, bx, by, 120, 120);
      expect(after / before, `蒙版外的高频能量应该被模糊抹掉（${before.toFixed(1)} → ${after.toFixed(1)}）`).toBeLessThan(
        0.6,
      );
    } else {
      expect(outside.chroma, "amount=1 时蒙版外应该没有彩度了").toBeLessThan(2);
    }
  });
}

test("切模板换效果：不能复用上一个效果的 shader", async () => {
  /*
   * three 缓存编译好的 program，key 默认是 onBeforeCompile.toString()，
   * 而我们那个函数的源码文本永远一样（效果片段是运行时插进模板字符串的）。
   * 不显式给 customProgramCacheKey 的话，切模板会拿到上一个效果的 shader。
   *
   * 两个方向的表现都极具迷惑性、都不报错：
   *   先 desaturate 后 pixelate → 跑 desaturate 的 shader，amount=0，画面完全不变
   *   先 pixelate 后 desaturate → 跑 pixelate 的 shader，blocks=(0,0)，1.0/0.0 → NaN uv
   *
   * 只在**同一个引擎上切模板**时才犯 —— 每次新建引擎的话第一个编译的永远是对的，
   * 所以这条必须走 switchTemplate 而不是 loadTemplate。
   */
  const base = await baseFrame("front");
  const W = base.width;
  const H = base.height;

  // 背景左上角，两个模板都会在这里作用（人在画面中间）
  const box = { x: (W * 0.05) | 0, y: (H * 0.08) | 0, w: 120, h: 120 };
  const stats = (frame: typeof base) => {
    let chroma = 0;
    let same = 0;
    let n = 0;
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        const o = (y * W + x) << 2;
        const [r, g, b] = [frame.data[o], frame.data[o + 1], frame.data[o + 2]];
        chroma += Math.max(r, g, b) - Math.min(r, g, b);
        if (
          Math.abs(r - base.data[o]) + Math.abs(g - base.data[o + 1]) + Math.abs(b - base.data[o + 2]) <= 6
        ) {
          same++;
        }
        n++;
      }
    }
    return { chroma: chroma / n, sameRatio: same / n };
  };

  const pixelate = path.join(TEMPLATES, "lowres-life.json");
  const desat = path.join(TEMPLATES, "colorful-me.json");

  // 方向一：pixelate → desaturate
  await loadTemplate(harness.page, pixelate, "front");
  await switchTemplate(harness.page, desat);
  const afterDesat = stats(decode(await capture(harness.page, 0)));
  expect(afterDesat.chroma, "切到 desaturate 后背景该没彩度了").toBeLessThan(3);

  // 方向二：desaturate → pixelate
  await loadTemplate(harness.page, desat, "front");
  await switchTemplate(harness.page, pixelate);
  const afterPixelate = stats(decode(await capture(harness.page, 0)));
  expect(afterPixelate.sameRatio, "切到 pixelate 后背景该被改写").toBeLessThan(0.35);
  expect(afterPixelate.chroma, "pixelate 不该把背景变灰").toBeGreaterThan(10);
});

test("蒙版左右不反向：人偏左时，判为人的区域必须落在屏幕右侧", async () => {
  /*
   * 这条断言是为了抓一个真实发生过的 bug：shader 里给蒙版多补了一次镜像，
   * 于是人越靠画面边缘，判定偏得越远。人站正中间时几乎看不出来 ——
   * 所以必须用偏心的 side fixture，front 对这个 bug 免疫。
   *
   * 直接量 mask-debug 画出来的蒙版，不要透过效果去反推。
   * 原来的判据是「和原帧逐像素相同的区域 = 清晰区 = 人」，那在**低纹理背景**上会崩：
   * side fixture 的背景是一面平墙，打没打码几乎一样，整片墙都会被算成「清晰区」，
   * 质心被拖到画面中间，断言随机红。判据依赖背景有没有花纹，本身就是错的。
   */
  await loadTemplate(harness.page, path.join(TEMPLATES, "mask-debug.json"), "side");
  const frame = decode(await capture(harness.page, 0));

  const W = frame.width;
  const H = frame.height;
  let sx = 0;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) << 2;
      // 调试视图把判为人的区域染成红色，背景是压暗的原图
      if (frame.data[o] - Math.max(frame.data[o + 1], frame.data[o + 2]) > 40) {
        sx += x / W;
        n++;
      }
    }
  }
  expect(n / (W * H), "应该存在成规模的人体区域").toBeGreaterThan(0.05);

  // side fixture 的人在视频空间 cx≈0.42，画面是镜像的，所以屏幕上应该在 0.58 附近。
  // 少翻一次的话会落在 0.42 —— 0.53 这个阈值两边都留了 0.05 的余量。
  const cx = sx / n;
  expect(cx, `人体区域质心 x=${cx.toFixed(3)}，应落在 0.58 附近而不是镜像位置 0.42`).toBeGreaterThan(0.53);
});

test("noface 下 onLost:clear 生效：背景恢复清晰，不崩溃", async () => {
  const tpl = path.join(TEMPLATES, "lowres-life.json");
  await loadTemplate(harness.page, tpl, "noface");
  const frame = decode(await capture(harness.page, 0));
  const base = await baseFrame("noface");

  const W = frame.width;
  const H = frame.height;
  const varBase = localVariance(base, (W * 0.06) | 0, (H * 0.1) | 0, 120, 120);
  const varNow = localVariance(frame, (W * 0.06) | 0, (H * 0.1) | 0, 120, 120);
  // clear：蒙版失效时全画面恢复原样，方差不该掉
  expect(varNow, "onLost:clear 时背景不应被马赛克").toBeGreaterThan(varBase * 0.75);
});

test("interactive：菜单能拖动、能滚轮缩放，且不影响非交互元素", async () => {
  const tpl = path.join(TEMPLATES, "lowres-life.json");
  await loadTemplate(harness.page, tpl, "front");
  const before = decode(await capture(harness.page, 0));

  // 从菜单中心往左上拖 120px
  const box = (await harness.page.locator("canvas").first().boundingBox())!;
  const cx = box.x + box.width * 0.78;
  const cy = box.y + box.height * 0.68;
  await harness.page.mouse.move(cx, cy);
  await harness.page.mouse.down();
  await harness.page.mouse.move(cx - 120, cy - 80, { steps: 6 });
  await harness.page.mouse.up();

  const dragged = decode(await capture(harness.page, 0));
  expect(diffRatio(before, dragged, 0.05), "拖过之后画面应该变了").toBeGreaterThan(0.005);

  // 滚轮放大，菜单面板本身的面积要变大
  await loadTemplate(harness.page, tpl, "front");
  const areaBefore = panelArea(decode(await capture(harness.page, 0)));
  await harness.page.mouse.move(cx, cy);
  await harness.page.mouse.wheel(0, -600);
  const areaAfter = panelArea(decode(await capture(harness.page, 0)));
  expect(areaAfter, "滚轮向上应该把菜单放大").toBeGreaterThan(areaBefore * 1.15);

  // 滚回去要变小，证明是双向的而不是只会长大
  await harness.page.mouse.wheel(0, 600);
  expect(panelArea(decode(await capture(harness.page, 0))), "滚轮向下应该把菜单缩小").toBeLessThan(areaAfter);
});

test("interactive：没声明 interactive 的元素不该被拖动", async () => {
  const tpl = path.join(TEMPLATES, "crying.json");
  await loadTemplate(harness.page, tpl, "front");
  const before = decode(await capture(harness.page, 0));

  // 往 (T_T) 文字上拖一把，它没有 interactive，画面应该纹丝不动
  const box = (await harness.page.locator("canvas").first().boundingBox())!;
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.92;
  await harness.page.mouse.move(cx, cy);
  await harness.page.mouse.down();
  await harness.page.mouse.move(cx - 150, cy - 100, { steps: 6 });
  await harness.page.mouse.up();

  const after = decode(await capture(harness.page, 0));
  expect(diffRatio(before, after, 0.05), "非交互元素不该被拖走").toBeLessThanOrEqual(0.0005);
});

test("帧效果必须挂在内置材质上，不能退回裸 ShaderMaterial", async () => {
  // 这条钉的是架构决定，不是像素。裸 ShaderMaterial 吃不到 three 的
  // DECODE_VIDEO_TEXTURE 宏 —— 视频纹理拿不到硬件 sRGB 解码，three 是在
  // 内置着色器里补的。用裸 shader 时，图片源颜色正确、摄像头源整体偏亮一次
  // sRGB 编码，而这个 harness 用的正是图片源，逐像素断言全都照过。
  // 也就是说这个 bug 只能靠真机发现 —— 所以在这里把选择本身钉死。
  await loadTemplate(harness.page, path.join(TEMPLATES, "lowres-life.json"), "front");
  expect(await harness.page.evaluate(() => window.harness.bgMaterialType())).toBe("MeshBasicMaterial");
});

test("文字用的是内嵌字体，不是系统字体", async () => {
  /*
   * 这条钉的是「golden 必须跨机器成立」。
   *
   * canvas 的 fillText 用系统字体，同一份 JSON 在 macOS 上落到 SF Pro Rounded、
   * 在 Linux CI 上落到 DejaVu Sans，字形不同 → 元素掩膜对不上。crying 底部那个
   * (T_T) 占了掩膜将近一半，实测只换字体就能把 IoU 从 1.0 打到 0.70，
   * 而 CI 上是 0.52 —— 这个仓库的 CI 因此红了不止一天。
   *
   * 所以断言的不是「画得像不像」，而是「那个 family 真的注册进去了」。
   * 有人把内嵌字体删掉换回系统字体栈，这条会立刻红，而不是等 CI 上莫名其妙的
   * 掩膜偏差去暴露。
   */
  await loadTemplate(harness.page, path.join(TEMPLATES, "crying.json"), "front");
  const loaded = await harness.page.evaluate(() =>
    document.fonts.check('700 64px "ARStudioText"'),
  );
  expect(loaded, "内嵌字体应该已经注册到 document.fonts").toBe(true);
});

test("生成器 id 确定：同一模板重复展开产出同一串 id", async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES, "crying.json"), "utf8"));
  const a = expandGenerators(raw.elements).map((e) => e.id);
  const b = expandGenerators(raw.elements).map((e) => e.id);
  expect(a).toEqual(b);
  expect(new Set(a).size).toBe(a.length);
});

/**
 * 混合模式。
 *
 * 验的是「方向对不对」和「透明区有没有被污染」，不是像素级外观：
 * multiply 只许压暗、screen 只许提亮，两者在元素范围外都必须逐像素不变
 * —— 后者是 multiply 最容易翻车的地方（透明区 rgb=0 会把整块背景乘成黑的）。
 */
for (const [blend, dir] of [
  ["multiply", "darker"],
  ["screen", "brighter"],
] as const) {
  test(`混合模式：${blend} 只${dir === "darker" ? "压暗" : "提亮"}，且不污染元素范围外`, async () => {
    const base = await baseFrame("front");

    const file = path.join(ARTIFACTS, `__blend-${blend}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        slug: `blend-${blend}`,
        name: { zh: "混合" },
        category: "test",
        price_cents: 0,
        template_type: "overlay",
        perception: [],
        elements: [
          {
            id: "patch",
            // gradient 是程序化画的，中心不透明、边缘全透明，
            // 一个元素同时覆盖「实心区」和「透明区」两种情况
            asset: { kind: "gradient", shape: "ellipse", color: "#8899AA" },
            anchor: { space: "screen", nx: 0.5, ny: 0.5 },
            size: { ref: "vw", scale: 0.3 },
            blend,
          },
        ],
      }),
    );
    await loadTemplate(harness.page, file, "front");
    const shot = decode(await capture(harness.page, 0));

    let changed = 0;
    let wrongWay = 0;
    for (let i = 0; i < base.data.length; i += 4) {
      const x = (i / 4) % base.width;
      const y = Math.floor(i / 4 / base.width);
      // 元素是 0.3W 宽、aspect 0.5，即半宽 0.15W、半高 0.075W。留一点富余
      const inside =
        Math.abs(x - base.width / 2) < base.width * 0.17 && Math.abs(y - base.height / 2) < base.width * 0.09;
      for (let c = 0; c < 3; c++) {
        const d = shot.data[i + c] - base.data[i + c];
        if (Math.abs(d) <= 1) continue; // 抗锯齿和量化的容差
        if (!inside) {
          wrongWay++; // 元素范围外任何变化都算污染
          continue;
        }
        changed++;
        if (dir === "darker" ? d > 0 : d < 0) wrongWay++;
      }
    }

    expect(changed, "元素得真的画上去了").toBeGreaterThan(1000);
    expect(wrongWay / changed, `${blend} 走反了方向或污染了范围外`).toBeLessThan(0.02);
  });
}

test("混合模式：screen 元素的 opacity 仍然有效", async () => {
  // three 的 opacity 只作用在 alpha 上，而 screen 的混合因子里没有 srcAlpha。
  // 不开 premultipliedAlpha 的话，这个元素淡出时完全不会变淡 ——
  // emit-fall-fade 的眼泪会一直亮到消失那一帧。
  const base = await baseFrame("front");
  const shoot = async (opacity: number) => {
    const file = path.join(ARTIFACTS, `__blend-opacity-${opacity}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        slug: `blend-opacity-${opacity}`,
        name: { zh: "混合" },
        category: "test",
        price_cents: 0,
        template_type: "overlay",
        perception: [],
        elements: [
          {
            id: "patch",
            asset: { kind: "gradient", shape: "ellipse", color: "#8899AA" },
            anchor: { space: "screen", nx: 0.5, ny: 0.5 },
            size: { ref: "vw", scale: 0.3 },
            blend: "screen",
            opacity,
          },
        ],
      }),
    );
    await loadTemplate(harness.page, file, "front");
    const shot = decode(await capture(harness.page, 0));
    let sum = 0;
    for (let i = 0; i < base.data.length; i += 4) {
      for (let c = 0; c < 3; c++) sum += shot.data[i + c] - base.data[i + c];
    }
    return sum;
  };

  const full = await shoot(1);
  const faded = await shoot(0.2);
  expect(full, "screen 应该提亮").toBeGreaterThan(0);
  expect(faded, "opacity 0.2 的提亮量应该明显小于 opacity 1").toBeLessThan(full * 0.5);
});

/* ============================================================
 * 缓动 / 抖动。纯函数，不进浏览器。
 *
 * 这两条钉的是「观感能力没有被优化回去」：EFFECT-QUALITY X-2 说的
 * 「调一个参数把效果调难看了 CI 全绿」，缓动被改回线性正是其中一例。
 * ============================================================ */

test("缓动：gravity 前半段走得比线性少，两端仍然钉在 0 和 1", () => {
  expect(applyEase(0.5, "gravity")).toBeLessThan(applyEase(0.5, "linear"));
  for (const ease of ["linear", "in", "out", "inout", "gravity", "bounce"] as const) {
    // f(0)=0、f(1)=1 是周期闭合断言成立的前提，任何新曲线都必须满足
    expect(applyEase(0, ease)).toBeCloseTo(0, 6);
    expect(applyEase(1, ease)).toBeCloseTo(1, 6);
  }
});

test("缓动：不写 ease 时 emit-fall-fade 的输出与线性逐位相同", () => {
  const base = { preset: "emit-fall-fade", distance: 1.2, period: 2.8 } as const;
  for (let t = 0; t < 2.8; t += 0.07) {
    const noEase = evaluateAnimations([{ ...base }], t, 720, 100);
    const linear = evaluateAnimations([{ ...base, ease: "linear" }], t, 720, 100);
    expect(noEase).toEqual(linear);
  }
});

test("生成器抖动：带 seed 的 jitter 重复展开逐元素相同，且确实打散了", () => {
  const trail = (jitter?: unknown) => [
    {
      generate: "trail",
      count: 4,
      step: 0,
      decay: 1,
      phaseShift: 0.9,
      anchor: { space: "screen", nx: 0.5, ny: 0.5 },
      item: {
        asset: { kind: "svg-lib", key: "tear-drop" },
        size: { ref: "iod", scale: 0.16 },
        animations: [{ preset: "emit-fall-fade", distance: 1.2, period: 2.8 }],
        ...(jitter ? { jitter } : {}),
      },
    },
  ];

  const jitter = { size: 0.25, phase: 0.2, offset: [0.05, 0.05], seed: 7 };
  const a = expandGenerators(trail(jitter) as never);
  const b = expandGenerators(trail(jitter) as never);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));

  // 不写 jitter 时 rng 的存在不许改变任何输出，包括 id 分配顺序
  const plain = expandGenerators(trail() as never);
  expect(plain.map((e) => e.id)).toEqual(a.map((e) => e.id));
  // trail 的 step:0 + decay:1 本来让四滴尺寸完全相同，抖动之后必须不同
  expect(new Set(plain.map((e) => e.size.scale)).size).toBe(1);
  expect(new Set(a.map((e) => e.size.scale)).size).toBeGreaterThan(1);
});
