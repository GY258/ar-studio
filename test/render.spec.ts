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
import { expandGenerators } from "../src/engine/generators";
import { applyEase, evaluateAnimations } from "../src/engine/animations";
import { migrateElements } from "../src/lib/migrate";
import {
  launchHarness,
  loadTemplate,
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

/** 展开后有没有动画。静态模板不该被「动画在动」那条断言卡住。 */
function hasAnimations(templatePath: string): boolean {
  const raw = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  return migrateElements(raw).elements.some((e) => (e.animations?.length ?? 0) > 0);
}

/** 有元素的模板才需要渲染回归；particle 模板走的是另一条线，本轮不碰。 */
function templatesWithElements(): string[] {
  return fs
    .readdirSync(TEMPLATES)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES, f), "utf8"));
      return Boolean(raw.elements ?? raw.overlay_elements ?? raw.face_track_elements);
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

  // 人脸中心（蒙版内）：应该原样保留
  expect(ratioIn((W * 0.44) | 0, (H * 0.32) | 0, 60, 60), "蒙版内应与原帧逐像素相同").toBeGreaterThan(0.97);
  // 左上角背景（蒙版外，菜单在右下角够不着）：马赛克应该把细节抹掉
  expect(ratioIn((W * 0.05) | 0, (H * 0.08) | 0, 120, 120), "蒙版外应被马赛克改写").toBeLessThan(0.25);
});

test("蒙版左右不反向：清晰区必须落在人身上（偏心画面才验得出来）", async () => {
  // 这条断言是为了抓一个真实发生过的 bug：shader 里给蒙版多补了一次镜像，
  // 于是人越靠画面边缘，清晰区偏得越远。人站正中间时几乎看不出来——
  // 所以必须用偏心的 side fixture，front 对这个 bug 免疫。
  const tpl = path.join(TEMPLATES, "lowres-life.json");
  await loadTemplate(harness.page, tpl, "side");
  const frame = decode(await capture(harness.page, 0));
  const base = await baseFrame("side");

  // 「和原帧逐像素相同」的区域就是没被马赛克的区域。
  // 菜单画在原帧没有的位置，自然不会被算进去，不用手动排除。
  const W = frame.width;
  const H = frame.height;
  let sx = 0;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) << 2;
      const d =
        Math.abs(frame.data[o] - base.data[o]) +
        Math.abs(frame.data[o + 1] - base.data[o + 1]) +
        Math.abs(frame.data[o + 2] - base.data[o + 2]);
      if (d <= 6) {
        sx += x / W;
        n++;
      }
    }
  }
  expect(n / (W * H), "应该存在成规模的清晰区").toBeGreaterThan(0.05);

  // side fixture 的人在视频空间 cx=0.38，画面是镜像的，所以屏幕上在 0.62 附近
  const sharpCx = sx / n;
  expect(sharpCx, `清晰区质心 x=${sharpCx.toFixed(3)}，应落在人身上（约 0.62）而不是镜像位置（约 0.38）`).toBeGreaterThan(
    0.55,
  );
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
