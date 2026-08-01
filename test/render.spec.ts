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
import { PNG } from "pngjs";
import { expandGenerators } from "../src/engine/generators";
import { applyEase, evaluateAnimations } from "../src/engine/animations";
import { PinchDetector } from "../src/engine/trail";
import { migrateElements } from "../src/lib/migrate";
import {
  launchHarness,
  loadTemplate,
  switchTemplate,
  capture,
  templatePeriod,
  captureDirect,
  setControl,
  setMirrored,
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

/**
 * 这个模板该用哪张 fixture 跑回归。
 *
 * 默认 front，但手部模板必须用 hands —— front 那张照片里没有手，
 * 手部锚点解不出来，元素全部隐藏，「元素覆盖的像素比例 > 0.001」直接红。
 * 按 perception 选而不是让模板自己声明测试用哪张图：测试用哪张输入是测试的事，
 * 不该污染产品 schema。
 */
function fixtureFor(templatePath: string): FixtureName {
  const raw = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  const p: string[] = Array.isArray(raw.perception) ? raw.perception : [];
  // 全身模板必须喂全身那张。front 是半身特写，姿态模型在上面读不到腿和脚，
  // 框会全挤在画面上半部 —— 测试过了但验的不是这个效果
  if (p.includes("pose")) return "body";
  if (p.includes("hands")) return "hands";
  return "front";
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

/**
 * 这些模板在 t=0 画面是空的 —— 内容由 fixture 序列中段的手势触发。
 *
 * 茎的长度完全由手指弯曲度决定，而序列的第 0 帧是伸开的手（按设计就该没有茎）。
 * 在 t=0 取 golden 会得到一张空图，然后「覆盖率 > 0.001」和掩膜 IoU
 * 全都在拿空集比空集 —— 断言还在，但已经什么都不保证了。
 * 所以把 golden 和三个探针一起平移到手势真正发生的时刻。
 */
const GOLDEN_AT: Record<string, number> = {
  // 弯曲扫动窗口是全程的 0.32~0.72，序列 3 秒 → 1.5s 落在峰值附近
  "finger-flowers": 1.5,
  "hand-stem": 1.5,
  // 轨迹在 t=0 只有一个采样点，画不出带。2.0s 时带已经长起来了
  "hand-trail": 2.0,
};

for (const file of templatesWithElements()) {
  const slug = path.basename(file, ".json");
  const templatePath = path.join(TEMPLATES, file);

  test(`${slug} · 渲染回归`, async () => {
    const { period: P, closes } = templatePeriod(templatePath);
    const fx = fixtureFor(templatePath);
    const t0At = GOLDEN_AT[slug] ?? 0;
    const count = await loadTemplate(harness.page, templatePath, fx);
    expect(count, "展开后应该有元素").toBeGreaterThan(0);

    const t0 = decode(await capture(harness.page, t0At));
    // 探针取 P/4 而不是 P/2：float 和 pulse 都是正弦，半周期正好又回到起点，
    // 用 P/2 会把「动画在动」误判成「没动」。P/4 是正弦的峰值。
    const tQuarter = decode(await capture(harness.page, t0At + P / 4));
    const tFull = decode(await capture(harness.page, t0At + P));

    const goldenPath = path.join(GOLDEN, `${slug}-t0.png`);

    if (UPDATE || !fs.existsSync(goldenPath)) {
      fs.writeFileSync(goldenPath, await capture(harness.page, t0At));
      test.info().annotations.push({ type: "golden", description: `已写入 ${slug}-t0.png，请人工过目后提交` });
    }

    // --- t=0 对 golden ---
    const golden = decode(fs.readFileSync(goldenPath));
    const ratio = diffRatio(t0, golden);
    if (ratio > DIFF_MAX) {
      fs.writeFileSync(path.join(ARTIFACTS, `${slug}-diff.png`), diffImage(t0, golden));
    }
    expect(ratio, `整帧差异像素比例（差异图见 test/.artifacts/${slug}-diff.png）`).toBeLessThanOrEqual(DIFF_MAX);

    const base = await baseFrame(fx);
    // baseFrame 换过模板，要把待测模板装回来
    await loadTemplate(harness.page, templatePath, fx);

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
      expect(diffRatio(t0, tQuarter, 0.05), `t=${t0At} 与 t=${t0At}+P/4（P=${P}s）应该有差异`).toBeGreaterThan(
        MOTION_MIN,
      );
    } else {
      test.info().annotations.push({
        type: "skipped-assertion",
        description: `${slug}: 模板没有声明任何动画，跳过「动画在动」和「周期闭合」两条断言`,
      });
      return;
    }

    // --- 周期闭合：相位算对了才闭得上 ---
    if (closes) {
      expect(diffRatio(t0, tFull, 0.05), `t=${t0At} 与 t=${t0At}+P（P=${P}s）应该几乎重合`).toBeLessThanOrEqual(
        CLOSURE_MAX,
      );
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

/** 水平翻转一张图。换到非镜像模式后，底图也得跟着翻才比得了 */
function flipX(img: PNG): PNG {
  const out = new PNG({ width: img.width, height: img.height });
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + (img.width - 1 - x)) << 2;
      const d = (y * img.width + x) << 2;
      for (let k = 0; k < 4; k++) out.data[d + k] = img.data[s + k];
    }
  return out;
}

/**
 * 「存在周期为 period 的竖直网格」有多强。
 *
 * 做法：逐列算和左邻列的平均差，然后按 period 做相位扫描，
 * 取「落在网格线上的列」和「块内部的列」的平均差之比，选最好的相位。
 * 有规则网格时接缝那几列的差远大于内部，比值会明显 > 1；
 * 照片上无论怎么扫都找不到这样的相位，比值贴近 1。
 *
 * 为什么不用「横向同色能连多远」：那个判据会被**我自己加的**块内渐变
 * （左侧高光、上下亮暗边）破坏 —— 块是实打实分了，但块内部并不是纯平色，
 * 于是连续同色长度上不去。判据得对得上真正做出来的东西，
 * 而这个效果真正保证的是「网格是规则的、周期等于声明的块大小」。
 */
function gridScore(
  img: { width: number; data: Uint8Array | Uint8ClampedArray },
  x0: number,
  y0: number,
  w: number,
  h: number,
  period: number,
) {
  const W = img.width;
  const colDiff: number[] = [];
  for (let x = x0 + 1; x < x0 + w; x++) {
    let acc = 0;
    for (let y = y0; y < y0 + h; y++) {
      const o = (y * W + x) << 2;
      const q = (y * W + x - 1) << 2;
      acc +=
        Math.abs(img.data[o] - img.data[q]) +
        Math.abs(img.data[o + 1] - img.data[q + 1]) +
        Math.abs(img.data[o + 2] - img.data[q + 2]);
    }
    colDiff.push(acc / h);
  }

  let best = 0;
  const P = Math.max(2, Math.round(period));
  for (let phase = 0; phase < P; phase++) {
    let onSum = 0;
    let onN = 0;
    let offSum = 0;
    let offN = 0;
    for (let i = 0; i < colDiff.length; i++) {
      if (i % P === phase) {
        onSum += colDiff[i];
        onN++;
      } else {
        offSum += colDiff[i];
        offN++;
      }
    }
    if (onN && offN && offSum > 0) best = Math.max(best, onSum / onN / (offSum / offN));
  }
  return best;
}

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
  [
    "voxel",
    { kind: "voxel", blocks: 30, palette: 0.55, levels: 7, saturate: 0.5, faceShade: 0.4, outline: 0.26, grain: 0.09, seed: 11 },
  ],
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
    } else if (kind === "voxel") {
      /*
       * 判据是**横向色块的平均长度**，不是「像素变了多少」。
       *
       * 体素化的产出必须是「成片的方块」。只看像素变化的话，一个只改了颜色、
       * 根本没分块的实现照样能过 —— 而那正是这个效果最可能的失败形态
       * （网格算错、blocks 传成 0、uniform 没接上，画面都还是「变了」的）。
       * 色块长度直接量「一行上连续同色能连多远」，分辨率无关，
       * 而且只有真的分块了才会涨上去。
       */
      // blocks 是「短边分几格」，harness 画布是横的，所以块边长 = 高 / blocks
      const period = frame.height / 30;
      const before = gridScore(base, bx, by, 120, 120, period);
      const after = gridScore(frame, bx, by, 120, 120, period);
      expect(after, `蒙版外应该出现周期 ${period.toFixed(1)}px 的规则网格（网格强度 ${after.toFixed(2)}）`).toBeGreaterThan(
        2.5,
      );
      expect(before, "原帧上不该找得到这个周期的网格，否则这条断言证明不了是效果做的").toBeLessThan(1.6);
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

test("手部感知：有手时元素显示，没手时隐藏", async () => {
  /*
   * 这条同时钉两件事。
   *
   * 一、`perception: ["hands"]` 真的接上了。它曾经是个**静默失效的枚举值** ——
   *     types.ts 和 validate.ts 都认，而 engine.perceive() 没有对应分支，
   *     模板写了能过校验、能渲染、什么都不发生、也不报错。和当初的 blur 一样。
   *     有人把 perceive 里那行删掉，这条会立刻红。
   *
   * 二、丢手兜底。手部元素在没有手时必须隐藏，而不是画到画面角上或者 (0,0)。
   */
  const tpl = path.join(TEMPLATES, "finger-flowers.json");

  // 取 GOLDEN_AT 那个时刻而不是 t=0：茎的长度由手指弯曲度决定，
  // 序列第 0 帧是伸开的手，按设计就该一根茎都没有 —— 在 t=0 断言「应该画出来」
  // 会永远红，而把它改成 t=0 断言「覆盖率 > 0」又等于什么都不验
  const at = GOLDEN_AT["finger-flowers"];
  await loadTemplate(harness.page, tpl, "hands");
  const withHands = decode(await capture(harness.page, at));
  const handsBase = await baseFrame("hands");
  expect(coverage(withHands, handsBase), "有手时指尖元素应该画出来").toBeGreaterThan(0.002);

  // front 那张照片里没有手，fixture 也没录 hands.json
  await loadTemplate(harness.page, tpl, "front");
  const noHands = decode(await capture(harness.page, at));
  const frontBase = await baseFrame("front");
  expect(coverage(noHands, frontBase), "没有手时手部元素必须全部隐藏").toBeLessThan(0.0005);
});

test("轨迹：状态层确定，且带真的在长", async () => {
  /*
   * 这条是整个跨帧状态层的验收条件。
   *
   * 加状态之前 renderAt(t) 是无历史的纯函数 —— golden 回归、CI 不用摄像头、
   * LLM 能拿到反馈全建立在那上面。加了轨迹之后必须证明「同一份输入渲染多少次
   * 都是同一张图」仍然成立，否则整套离线验证就废了。
   *
   * 三件事一起验：
   *   长  —— 带确实随时间变长（不然「实现了」和「画了个空」分不开）
   *   确定 —— 同一个 t 渲染两次逐位相同。第二次会触发时间倒流 → 清状态 → 从头重积，
   *           这恰好是最容易出错的路径：只要有一点状态没清干净，两张图就不一样
   *   非空 —— 带真的画出了像素，不是几何算对了但顶点全塌在一起
   */
  /*
   * 用专门的探针模板 hand-trail，不用 finger-flowers。
   *
   * finger-flowers 换成 stem 之后一个 trail 元素都不剩了，而这条测试当时**还是绿的** ——
   * covEarly 在 t=0.3 恰好是 0（弯曲窗口还没开始），比值成了 Infinity；
   * covLate 在 t=2.4 量到的是捏合开出来的花（2.4/3 正好落在第二段捏合窗口里）。
   * 也就是说它在拿捏合的像素证明轨迹在长。
   *
   * trail 这个 asset 引擎里还实现着，没有模板用它就等于零覆盖 —— 所以留一个
   * hidden 的探针模板专门钉它，而不是把断言删掉。
   */
  const tpl = path.join(TEMPLATES, "hand-trail.json");
  await loadTemplate(harness.page, tpl, "hands");
  const base = await baseFrame("hands");
  await loadTemplate(harness.page, tpl, "hands");

  // 0.9 / 2.7：探针锚在手腕和指根上，只受下落影响。下落是 p^1.25、起步慢，
  // 所以 early 不能太早（0.6s 时只有几百个像素，那个量级下比值和除以零没区别）
  const early = decode(await capture(harness.page, 0.9));
  const lateBuf = await capture(harness.page, 2.7);
  const late = decode(lateBuf);

  const covEarly = coverage(early, base);
  const covLate = coverage(late, base);
  expect(covEarly, "早期就该有一小段带了，否则下面的比值是在除以零").toBeGreaterThan(0.0015);
  // 0.006 ≈ 3000 个像素，肉眼一眼能看到的一条带。
  // 这个数是按 hand-trail 这个探针（4 条带、宽 0.11 掌宽）定的，
  // 不是沿用原来 finger-flowers 十条带时代的 0.01 —— 那个数对这里已经没有依据，
  // 而「为了压过一个陈旧的阈值去调模板参数」是把断言调成必过，不是验证
  expect(covLate, "带应该画出成规模的像素").toBeGreaterThan(0.006);
  expect(covLate / covEarly, `带应该随时间变长（${covEarly.toFixed(4)} → ${covLate.toFixed(4)}）`).toBeGreaterThan(1.5);

  // 再来一次同一个 t。走的是「时间倒流 → 清状态 → 重新按定步长积到 2.4」
  const again = await capture(harness.page, 2.7);
  expect(again.equals(lateBuf), "同一个 t 渲染两次必须逐位相同，否则状态没清干净或步长不定").toBe(true);
});

test("Fluidity：人一动线条就加速，站着不动就慢下来", async () => {
  /*
   * 参考素材里人卡点一动，线条明显跟着加速；站着不动时变化得很慢。
   *
   * **这条是速度驱动的，和密度那条不是一回事。** 密度走 spread（姿态本身，
   * 慢慢张开手臂也该炸），节奏走 motion（慢慢张开时节奏不该变快）。
   * 我一开始把两者混在一起判断过 —— 说「密度由姿态驱动不由速度驱动」，
   * 那对密度是对的，但节奏确实只能由速度定，从单帧姿态推不出来。
   *
   * 代价：速度按定义需要两帧，fluidity 因此加入「需要 stepTo」那一族。
   *
   * fixture 的手臂开合是 sin(π·p)，4 秒一个来回：
   *   t=2.0 在正弦峰值，导数为 0 → 姿态最舒展但**速度为 0**
   *   t=1.0 在上升段中点 → 速度最大
   * 正好能把「姿态」和「速度」这两个因素分开验 —— 如果实现错误地把密度那套
   * spread 拿来驱动节奏，t=2.0 的速率会是最高而不是最低。
   */
  const tpl = path.join(TEMPLATES, "fluidity.json");
  const rate = () =>
    harness.page.evaluate(
      () =>
        (window as unknown as { harness: { engine: { debugStats(): { fluidityRate: number } } } }).harness.engine
          .debugStats().fluidityRate,
    );

  await loadTemplate(harness.page, tpl, "body");
  await capture(harness.page, 1.0);
  const moving = await rate();
  await capture(harness.page, 2.0);
  const peakPose = await rate();

  expect(moving, "手臂挥到一半时该跑满速率").toBeGreaterThan(10);
  expect(peakPose, `姿态最舒展但速度为 0 时该慢下来（挥动 ${moving.toFixed(1)} → 峰值 ${peakPose.toFixed(1)}）`)
    .toBeLessThan(moving * 0.6);
});

test("换后置摄像头：元素跟着不镜像，不能贴到镜像的位置上", async () => {
  /*
   * 前置摄像头画面是镜像的（自拍抬左手看着是左手动），后置不是。
   * 这一位要一路传到**元素定位、占据场、泡泡折射**，漏掉任何一处的表现都是
   * 「元素贴在了镜像的位置上」—— 画面里人在左边，框却扣在右边。
   *
   * **而且只有换到后置才看得出来**：一直用前置的话，漏掉的那一处和其余部分
   * 恰好都用同一个约定，永远不会暴露。这个仓库的镜像约定已经踩过三次，
   * 所以这条断言必须存在。
   *
   * 判据：元素的重心 x 应该关于画面中心翻过去。
   * 如果元素忘了跟着翻，背景翻了而元素没动 —— 重心留在原处，这条立刻红。
   */
  const tpl = path.join(TEMPLATES, "black-lodge.json");
  await loadTemplate(harness.page, tpl, "front");
  const base = await baseFrame("front");
  await loadTemplate(harness.page, tpl, "front");

  const mirrored = decode(await capture(harness.page, 0));
  const cm = maskCentroid(mirrored, base);
  expect(cm, "镜像模式下该有元素").toBeTruthy();

  await setMirrored(harness.page, false);
  const plain = decode(await capture(harness.page, 0));
  /*
   * 底图也要重新拍：背景平面跟着翻了，拿镜像那张底图比的话
   * 整个画面都算「和底图不同」，重心会落在画面正中，什么都测不出来。
   */
  const baseFlipped = flipX(base);
  const cp = maskCentroid(plain, baseFlipped);
  expect(cp, "非镜像模式下该有元素").toBeTruthy();

  // 重心 x 关于中心翻过去。容差 0.06 屏宽：元素本身不翻转（文字要正着读），
  // 所以两边的包围盒不会严格对称
  expect(Math.abs(cm!.x + cp!.x - 1), `重心该关于中心翻过去（${cm!.x.toFixed(3)} / ${cp!.x.toFixed(3)}）`)
    .toBeLessThan(0.06);
});

test("滑块对非 particle 模板真的有用", async () => {
  /*
   * 这条堵的是又一个**静默失效**：`controls` 原来只在 particle 模板的分支里
   * 被 resolveControls 消费，overlay / facetrack 模板写了 controls ——
   * 能过校验、面板上画得出滑块、拖了什么都不发生、也不报错。
   * 和当初的 blur、hands、posterize 是同一类。
   *
   * 断言必须**拨完之后看东西真的变了**。只断言「setControls 不抛异常」的话，
   * 什么都没接上的实现照样能过。
   */
  const tpl = path.join(TEMPLATES, "fluidity.json");
  const boxes = () =>
    harness.page.evaluate(
      () =>
        (window as unknown as { harness: { engine: { debugStats(): { fluidityBoxes: number } } } }).harness.engine
          .debugStats().fluidityBoxes,
    );

  // baseFrame 会**换模板**（装一个空的去拍底图），所以必须先取、再把待测模板装回来。
  // 中途调它的话后面全在拿空模板做断言 —— 第一版就是这么翻的车，覆盖率直接 0
  await loadTemplate(harness.page, tpl, "body");
  const base = await baseFrame("body");
  await loadTemplate(harness.page, tpl, "body");

  await capture(harness.page, 0);
  const before = await boxes();

  // intensity 是离散四档，绑在 element.fluidity.density 上
  await setControl(harness.page, "intensity", 0.85);
  await capture(harness.page, 0);
  const after = await boxes();
  expect(after, `拨到「爆」档框该变多（${before} → ${after}）`).toBeGreaterThan(before);

  await setControl(harness.page, "intensity", 0.12);
  await capture(harness.page, 0);
  expect(await boxes(), "拨回「轻」档框该变少").toBeLessThan(after);

  /*
   * 连续滑块也要真的作用：把框调大，画面覆盖率该涨。
   *
   * 先把编号关掉（labels → 0）再量。覆盖率里混着线和编号，它们不随 boxSize 变，
   * 会把信号稀释到 1.36 —— 那时候不该去调阈值迁就它，该把噪声去掉。
   * 顺带这也验了 labels 那个滑块是接上的：关掉之后覆盖率必须先掉一截。
   */
  await setControl(harness.page, "intensity", 0.85);
  const withLabels = coverage(decode(await capture(harness.page, 0)), base);
  await setControl(harness.page, "labels", 0);
  const small = coverage(decode(await capture(harness.page, 0)), base);
  expect(small, `关掉编号覆盖率该掉一截（${withLabels.toFixed(4)} → ${small.toFixed(4)}）`).toBeLessThan(
    withLabels * 0.92,
  );

  await setControl(harness.page, "boxSize", 0.35);
  const big = coverage(decode(await capture(harness.page, 0)), base);
  expect(big / small, `把框调大覆盖率该涨（${small.toFixed(4)} → ${big.toFixed(4)}）`).toBeGreaterThan(1.5);
});

test("Fluidity：框挂在全身关节上，密度跟着姿态爆发", async () => {
  /*
   * 断言直接读框的个数，不看像素。
   *
   * 「框变多了」和「人走近了所以框变大了」在覆盖率上分不开 ——
   * 而这个效果的灵魂正是**数量**随姿态爆发。参考素材里张开手臂那一帧
   * 框和线炸开、手收拢时骤减。
   *
   * 密度由 spread（双腕间距 / 肩宽）驱动，是**当前帧的纯函数**，不是运动速度。
   * fixture 的手臂开合是合成的（见 scripts/make-pose-sequence.ts）——
   * 两张全身照都是手垂着的，不合成的话 spread 恒定，这条断言什么都证明不了。
   */
  const tpl = path.join(TEMPLATES, "fluidity.json");
  const stats = () =>
    harness.page.evaluate(
      () =>
        (
          window as unknown as {
            harness: { engine: { debugStats(): { fluidityBoxes: number; fluidityLowestY: number } } };
          }
        ).harness.engine.debugStats(),
    );
  const boxes = async () => (await stats()).fluidityBoxes;

  await loadTemplate(harness.page, tpl, "body");
  const base = await baseFrame("body");
  await loadTemplate(harness.page, tpl, "body");

  // 序列是 4 秒一个来回：t=0 手垂着，t=2 张到最开
  await capture(harness.page, 0);
  const closedStats = await stats();
  const closed = closedStats.fluidityBoxes;
  const shot = await capture(harness.page, 2.0);
  const open = await boxes();

  expect(closed, "手垂着时也该有几个框 —— 全清读起来像检测断了").toBeGreaterThan(2);
  /*
   * 1.5 倍而不是 2 倍。
   *
   * 密度是 boxes * (0.42 + 0.58 * spread)，而 fixture 是走路姿势、静止时
   * spread 已经有 0.25 —— 从 0.565 涨到 1.0 就是 1.77 倍，再往上会撞到
   * boxes 这个上限。写 2 倍的话这条永远红，而红的原因是「上限卡住了」
   * 不是「密度不跟姿态走」。断言的倍数得按设计上能达到的范围定。
   */
  expect(open, `张开手臂时框该爆发式增多（${closed} → ${open}）`).toBeGreaterThan(closed * 1.5);
  expect(coverage(decode(shot), base), "框和线该画出成规模的像素").toBeGreaterThan(0.004);

  /*
   * 框要贴着**全身**，不是全挤在上半身。POSE_BOX_POINTS 按解剖顺序排，
   * 取前缀的话框全落在脸和手臂上，腿上一个都没有。
   *
   * 这条得**单独用一个框很少的配置**去验，踩了三次才写对：
   *   一、量张开那一帧没用 —— 框数超过关节总数（19）时所有锚点都会被用上，
   *       取前缀和均匀铺开出来一模一样。
   *   二、用像素带量也没用 —— 连接线也落在下半部分，把断言污染到改回取前缀照样绿。
   *   三、改用「最低那个框在哪」之后，产品模板的密度下限（0.42）又保证了
   *       框数永远 ≥ 关节数 —— 这条路在**这个模板上**跑不到。
   * 所以写一个 boxes: 10 的临时模板，那才是这段逻辑真正生效的区间。
   */
  const sparse = path.join(ARTIFACTS, "__fluidity-sparse.json");
  const raw = JSON.parse(fs.readFileSync(tpl, "utf8"));
  raw.elements[0].asset.boxes = 10;
  fs.writeFileSync(sparse, JSON.stringify(raw));
  await loadTemplate(harness.page, sparse, "body");
  await capture(harness.page, 0);
  expect((await stats()).fluidityLowestY, "框少的时候也该铺到腿和脚上，不能全挤在上半身").toBeGreaterThan(0.72);

  await loadTemplate(harness.page, tpl, "body");
  await capture(harness.page, 2.0);

  // 同一个 t 再来一次：编号和抖动都是 hash 的纯函数，必须逐位相同
  await capture(harness.page, 3.5);
  const again = await capture(harness.page, 2.0);
  expect(again.equals(shot), "同一个 t 渲染两次必须逐位相同 —— 编号不许用随机数").toBe(true);

  // 没有姿态的 fixture：整套线框必须消失，而不是画到画面角上
  await loadTemplate(harness.page, tpl, "front");
  expect(await boxes(), "没检测到人时不该有任何框").toBe(0);
});

test("泡泡：一开场就满屏、在动、指尖真的能戳破", async () => {
  /*
   * 四件事一起验，因为**光看画面分不清它们**：泡泡少了，可能是被戳破了，
   * 也可能是飘走了；泡泡没动，可能是模拟停了，也可能是恰好那一帧。
   * 所以「戳破」那条直接读活着的泡泡数，不看像素。
   *
   * 第一条钉的是这次改的需求：泡泡**不从画面底边冒出来**，t=0 时整屏就该是满的。
   * 上一版是从底部一个个飘上来的，那条路上 t=0 画面几乎是空的 ——
   * 只断言「整帧覆盖率 > 0」的话，两种实现都能过。
   */
  const tpl = path.join(TEMPLATES, "soap-bubbles.json");
  const alive = () =>
    harness.page.evaluate(
      () =>
        (window as unknown as { harness: { engine: { debugStats(): { bubblesAlive: number } } } }).harness.engine
          .debugStats().bubblesAlive,
    );

  /** 指定横条里有多少像素和底图不同 */
  const bandCov = (
    img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray },
    base: { width: number; data: Uint8Array | Uint8ClampedArray },
    y0f: number,
    y1f: number,
  ) => {
    let n = 0;
    let total = 0;
    for (let y = Math.floor(img.height * y0f); y < Math.floor(img.height * y1f); y++) {
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) << 2;
        const d =
          Math.abs(img.data[o] - base.data[o]) +
          Math.abs(img.data[o + 1] - base.data[o + 1]) +
          Math.abs(img.data[o + 2] - base.data[o + 2]);
        if (d > 12) n++;
        total++;
      }
    }
    return n / total;
  };

  await loadTemplate(harness.page, tpl, "front");
  const base = await baseFrame("front");
  await loadTemplate(harness.page, tpl, "front");

  // --- 一开场就满屏：t=0 的**上四分之一**就该有泡泡 ---
  const t0 = decode(await capture(harness.page, 0));
  expect(bandCov(t0, base, 0, 0.25), "t=0 时画面顶部就该有泡泡，不是从底边冒上来").toBeGreaterThan(0.05);

  // --- 在动 ---
  const later = decode(await capture(harness.page, 4.0));
  expect(diffRatio(t0, later, 0.05), "泡泡应该在飘").toBeGreaterThan(0.05);

  await capture(harness.page, 3.0);
  const noHands = await alive();
  expect(noHands, "没有手时一个都不该破").toBe(30);

  /*
   * --- 有手：每个槽位的位置是 hash(槽位, 第几代, seed) 的纯函数，
   *     两次跑的冒泡序列完全一样，所以活着的变少只可能是被戳破了 ---
   */
  await loadTemplate(harness.page, tpl, "hands");
  const buf = await capture(harness.page, 3.0);
  const withHands = await alive();
  expect(withHands, `指尖划过去应该戳破一些（无手 ${noHands} → 有手 ${withHands}）`).toBeLessThan(noHands);

  /*
   * --- 破了不再生，所以最终能清空。这是这个玩具的终局，也是它和屏保的区别 ---
   *
   * 泡泡纵向绕回（飘出顶端从底端进来），fixture 里那只手是张开的手掌 ——
   * 所以只要跑得够久，每个泡泡都会飘过手掌被戳破。
   * 断言是**单调递减**加上最终清空：会补充的实现过不了单调那一条。
   */
  const trail: number[] = [];
  for (const tt of [6, 12, 20, 30, 42]) {
    await capture(harness.page, tt);
    trail.push(await alive());
  }
  for (let i = 1; i < trail.length; i++) {
    expect(trail[i], `活着的泡泡只能变少不能变多（${trail.join(" → ")}）`).toBeLessThanOrEqual(trail[i - 1]);
  }
  /*
   * 断言「剩得很少」而不是「归零」。
   *
   * 归零离线达不到，而且**原因在 fixture 不在代码**：泡泡横向只摆动 2% 画面宽，
   * 而 fixture 里那只手固定在画面中间 —— 最左最右两列的泡泡永远碰不到它。
   * 真机上手能划到任何地方，全戳完是做得到的。
   *
   * 写成 toBe(0) 的话这条会一直红，而红的原因和被测行为无关；
   * 放宽到「没有补充」+「掉到个位数」才是这个环境能证明的事。
   */
  expect(trail[trail.length - 1], `跑够久该只剩边角上碰不到的几个（${trail.join(" → ")}）`).toBeLessThan(8);

  // 同一个 t 再来一次：戳破是仅有的可变状态，它必须可回放
  await capture(harness.page, 3.0);
  const again = await capture(harness.page, 3.0);
  expect(again.equals(buf), "同一个 t 渲染两次必须逐位相同 —— 戳破的状态没清干净就会不一样").toBe(true);
});

test("时间倒流之后，同一个 t 必须和顺着走到 t 完全一样", async () => {
  /*
   * 这条钉的是一个真的踩过的 bug：stepTo 在倒流时调了 resetSim()，
   * 而 resetSim 把 simT 设成 -1 —— 又正好被「首次调用不从 0 补一整段」
   * 那条优化当成首次调用，于是倒流回 t 只喂了一个采样点，轨迹是空的。
   *
   * 表现是「同一个 t，之前渲染过更晚的时刻再回来，画面不一样」。
   * 离线 harness 到处在跳时刻（golden 在 t0、探针在 t0+P/4 和 t0+P，
   * 然后回头再取 t0），所以这不是个理论问题 —— 它当场让 hand-trail 的
   * golden 录不出来。
   *
   * 用有状态的 hand-trail 测：无状态模板走哪条路都一样，证明不了任何事。
   */
  const tpl = path.join(TEMPLATES, "hand-trail.json");
  await loadTemplate(harness.page, tpl, "hands");
  const base = await baseFrame("hands");
  await loadTemplate(harness.page, tpl, "hands");

  const first = await capture(harness.page, 1.5);
  expect(coverage(decode(first), base), "这个时刻带必须真的画出来了").toBeGreaterThan(0.004);

  await capture(harness.page, 2.7); // 先走到更晚的时刻
  const rewound = await capture(harness.page, 1.5); // 再倒回来

  expect(rewound.equals(first), "倒流回同一个 t 必须逐位相同 —— 否则状态清了但没重积").toBe(true);
});

test("茎是纯函数：直接跳到 t 和逐步积到 t 必须一模一样", async () => {
  /*
   * 这条钉的是**换掉轨迹机制的全部理由**。
   *
   * 参考视频里的动作是「弯一下手指，从画面底部长一根上来」。原来那版用的是轨迹
   * （锚点走过的路），要求你挥手才有东西看、手一停就开始淡出，而且它带跨帧状态 ——
   * 所以整个离线验证都得走 stepTo 一步步积过去。
   *
   * 新的茎把长度直接绑在**当前帧**的手指弯曲度上：弯多少长多少。
   * 这让它回到「renderAt(t) 是无历史的纯函数」——而那正是 golden 回归、
   * CI 不用摄像头、LLM 能拿到反馈的地基。
   *
   * 所以断言是：同一个 t，直接跳过去 和 按定步长积过去，两张图**逐位相同**。
   * 只要有人往茎里塞了一点历史（比如「长出来要有个生长动画」），这条立刻红。
   *
   * 用 hand-stem 探针而不是 finger-flowers：后者还带着 pinch-bloom，
   * 那个是真有状态的，会让这条断言必红 —— 而且红的原因和茎无关。
   */
  const tpl = path.join(TEMPLATES, "hand-stem.json");
  await loadTemplate(harness.page, tpl, "hands");
  const base = await baseFrame("hands");
  await loadTemplate(harness.page, tpl, "hands");

  // 1.5s 落在弯曲扫动的峰值附近，茎是长着的 —— 拿一张空图比空图证明不了纯函数
  const stepped = await capture(harness.page, 1.5);
  expect(coverage(decode(stepped), base), "这个时刻茎必须真的画出来了").toBeGreaterThan(0.004);

  const direct = await captureDirect(harness.page, 1.5);
  expect(direct.equals(stepped), "直接跳到 t 和逐步积到 t 必须逐位相同 —— 茎里不许有历史").toBe(true);
});

test("捏合是边沿触发，不是状态触发", () => {
  /*
   * 纯函数，不进浏览器。
   *
   * 这条钉的是「一次动作 = 一朵花」。用状态触发（每帧只看在不在捏）的话，
   * 捏住一秒会蹦出十几朵 —— 而且这个 bug 在截图上看不出来，
   * 因为叠在一起的花和一朵花长得差不多。
   *
   * 顺带钉住迟滞：单阈值会在临界点反复触发，手抖一下就是一串。
   */
  const d = new PinchDetector(2);
  // 松开状态喂几帧，不该触发
  expect(d.update(0.0, 0.9, 0.5, 0.5)).toBe(false);
  expect(d.update(0.1, 0.6, 0.5, 0.5)).toBe(false);
  // 越过 ON 阈值：触发一次
  expect(d.update(0.2, 0.2, 0.5, 0.5)).toBe(true);
  // 继续捏着：不该再触发
  expect(d.update(0.3, 0.15, 0.5, 0.5)).toBe(false);
  expect(d.update(0.4, 0.25, 0.5, 0.5)).toBe(false);
  // 回到 ON 和 OFF 之间的迟滞带：仍然算捏着，不该重新触发
  expect(d.update(0.5, 0.35, 0.5, 0.5)).toBe(false);
  expect(d.live().length).toBe(1);
  // 越过 OFF 阈值才算松开，之后再捏才是第二次
  expect(d.update(0.6, 0.5, 0.5, 0.5)).toBe(false);
  expect(d.update(0.7, 0.2, 0.5, 0.5)).toBe(true);
  expect(d.live().length).toBe(2);
  // 超过存活时长的事件要过期
  d.update(3.0, 0.9, 0.5, 0.5);
  expect(d.live().length).toBe(0);
});

test("捏合绽放：捏合窗口里真的开出花", async () => {
  // fixture 序列的捏合窗口在全程 30%~40%，3 秒序列就是 0.9~1.2s
  const tpl = path.join(TEMPLATES, "finger-flowers.json");
  await loadTemplate(harness.page, tpl, "hands");
  const base = await baseFrame("hands");
  await loadTemplate(harness.page, tpl, "hands");

  const before = coverage(decode(await capture(harness.page, 0.8)), base);
  const during = coverage(decode(await capture(harness.page, 1.05)), base);
  expect(during, `捏合时该多出一朵（${before.toFixed(4)} → ${during.toFixed(4)}）`).toBeGreaterThan(before * 1.15);
});

test("切模板不留残渣：池化的 mesh 也要拆干净", async () => {
  /*
   * 这条堵的是我真的犯过的一个 bug：trail 的叶子池和 pinch-bloom 的花池是单独
   * add 到 group 里的，而 clear() 原来只移除 item.mesh —— 从「指尖开花」切走之后，
   * 叶子还挂在脸上，永久不走。
   *
   * **断言必须是结构性的，不能看像素。** 我第一版写的是「切换后覆盖率应该接近底图」，
   * 结果 bug 在的时候它照样绿：切换那一刻 131 个泄漏对象里只有 3 个恰好是可见的
   * （叶子池里超出当前茎长的那些本来就隐藏着），像素上根本看不出来。
   * 而在真机上它非常明显 —— 用户切换时手已经动了一阵，茎长、叶子多。
   *
   * 不可见的泄漏仍然是泄漏：内存在涨，而且换个时机就会露出来。
   * 所以比的是「同一个模板，全新装载 vs 从别的模板切过来」的对象数。
   * 这样也不用把「black-lodge 有几个 mesh」这种数字写死在测试里。
   */
  const objects = () =>
    harness.page.evaluate(
      () =>
        (window as unknown as { harness: { engine: { debugStats(): { elementObjects: number } } } }).harness.engine
          .debugStats().elementObjects,
    );

  const target = path.join(TEMPLATES, "black-lodge.json");

  // 基准：全新装载 black-lodge 该有多少个对象
  await loadTemplate(harness.page, target, "hands");
  const fresh = await objects();
  expect(fresh, "基准本身得非零，否则这条断言是空的").toBeGreaterThan(0);

  // 装一个有池化 mesh 的模板，跑到轨迹和绽放都长出来，再在**同一个引擎上**切过去
  await loadTemplate(harness.page, path.join(TEMPLATES, "finger-flowers.json"), "hands");
  await capture(harness.page, 1.6);
  const loaded = await objects();
  expect(loaded, "指尖开花的对象数该远多于 black-lodge（有叶子池和花池）").toBeGreaterThan(fresh * 3);

  await switchTemplate(harness.page, target);
  expect(await objects(), "切过来之后的对象数必须和全新装载一致").toBe(fresh);
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
