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

test("lowres-life：蒙版内像素接近原帧，蒙版外方差显著下降", async () => {
  const tpl = path.join(TEMPLATES, "lowres-life.json");
  await loadTemplate(harness.page, tpl, "front");
  const frame = decode(await capture(harness.page, 0));
  const base = await baseFrame("front");

  const W = frame.width;
  const H = frame.height;
  // 人脸中心一块（蒙版内）和左上角一块（蒙版外，且不被菜单遮住）
  const insideVarBase = localVariance(base, (W * 0.45) | 0, (H * 0.35) | 0, 60, 60);
  const insideVarNow = localVariance(frame, (W * 0.45) | 0, (H * 0.35) | 0, 60, 60);
  const outsideVarBase = localVariance(base, (W * 0.06) | 0, (H * 0.1) | 0, 120, 120);
  const outsideVarNow = localVariance(frame, (W * 0.06) | 0, (H * 0.1) | 0, 120, 120);

  expect(Math.abs(insideVarNow - insideVarBase), "蒙版内（人）应该基本没被改动").toBeLessThan(
    Math.max(20, insideVarBase * 0.5),
  );
  expect(outsideVarNow, "蒙版外（背景）局部方差应显著低于原帧").toBeLessThan(outsideVarBase * 0.75);
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

test("生成器 id 确定：同一模板重复展开产出同一串 id", async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES, "crying.json"), "utf8"));
  const a = expandGenerators(raw.elements).map((e) => e.id);
  const b = expandGenerators(raw.elements).map((e) => e.id);
  expect(a).toEqual(b);
  expect(new Set(a).size).toBe(a.length);
});
