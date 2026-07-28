/**
 * v1 → v2 元素兼容层。
 *
 * 只在 loadTemplate 阶段跑一次，转换结果参与校验和渲染 —— 引擎和校验器里
 * 都不该再出现 v1 的字段名。全部模板迁完之后，删掉这个文件和它的调用点即可。
 *
 * 每次触发都 console.warn 一条，带 slug 和字段名，方便盯着迁移进度。
 */

import type { ElementV2, ElementAsset } from "@/engine/types";
import { expandGenerators, type ElementOrGenerator } from "@/engine/generators";
import { getSvgAspect } from "@/engine/svg-assets";
import { FACE_ANCHORS } from "@/engine/anchors";

type Raw = Record<string, unknown>;

/** v1 里 blush 唯一的那个粉色，写死在 face-renderer 里，颜色不可配。 */
const V1_BLUSH_COLOR = "rgba(242,147,126,0.5)";

/** 数字 landmark 反查语义名，让兼容层产出的 v2 元素也只带语义名。 */
const NAME_BY_INDEX = new Map<number, string>(
  Object.entries(FACE_ANCHORS).map(([name, idx]) => [idx as number, name]),
);

export interface MigrationResult {
  elements: ElementV2[];
  /** 触发过的兼容项，调用方负责打印 */
  warnings: string[];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** v1 的 float / fall 两个具名槽位 → v2 动画数组。 */
function v1Animations(e: Raw): ElementV2["animations"] {
  const out: NonNullable<ElementV2["animations"]> = [];
  const float = e.float as Raw | undefined;
  if (float && num(float.period)) {
    out.push({ preset: "float", amplitude: (num(float.amplitude) ?? 0.01), period: num(float.period)! });
  }
  const fall = e.fall as Raw | undefined;
  if (fall && num(fall.period)) {
    out.push({ preset: "fall", period: num(fall.period)!, phase: num(fall.phase) ?? 0 });
  }
  return out.length ? out : undefined;
}

function textAsset(e: Raw): ElementAsset {
  return {
    kind: "text",
    text: e.text as string,
    color: (e.color as string) ?? undefined,
    fontWeight: num(e.fontWeight),
    shadow: (e.shadow as string) ?? undefined,
  };
}

/* ---------------- overlay_elements（v1） ---------------- */

function migrateOverlay(elems: Raw[], warn: (s: string) => void): ElementV2[] {
  warn("overlay_elements → elements（v1 元素格式）");
  return elems.flatMap((e, i): ElementV2[] => {
    const id = (e.id as string) ?? `ov-${i}`;
    const asset: ElementAsset | null =
      e.svgAsset ? { kind: "svg-lib", key: e.svgAsset as string } : e.text ? textAsset(e) : null;
    if (!asset) return [];

    // v1 的 overlay-renderer 对 svg 和文字一视同仁：宽度 = W × sizeW，
    // fontSizeW 只影响栅格化清晰度，不影响布局。所以这里一律 fit:"width"。
    return [{
      id,
      asset,
      anchor: { space: "screen", nx: num(e.nx) ?? 0.5, ny: num(e.ny) ?? 0.5 },
      size: { ref: "vw", scale: num(e.sizeW) ?? 0.1, fit: "width" },
      rotation: num(e.rotation),
      opacity: num(e.opacity),
      animations: v1Animations(e),
    }];
  });
}

/* ---------------- face_track_elements（v1） ---------------- */

interface V1FaceAnimation {
  breathe?: { scaleRange: [number, number]; period: number };
  tears?: { count: number; distance: number; period: number; phaseShift: number };
}

function migrateFaceTrack(elems: Raw[], anim: V1FaceAnimation | undefined, warn: (s: string) => void): ElementV2[] {
  warn("face_track_elements → elements（v1 元素格式）");
  if (anim) warn("face_track_animation → 元素级 animations（具名槽位已删除）");

  // 相位序号按「同一 landmark + 同一侧下的出现顺序」算。
  // v1 是从 id 字符串末位取的（id.slice(-1)），改个名字动画就坏，生成器产出的
  // id 形如 tear-17 时相位完全是碰运气。这里按出现序号算，行为确定。
  const trailSeq = new Map<string, number>();

  return elems.flatMap((e, i): ElementV2[] => {
    const id = (e.id as string) ?? `ft-${i}`;
    const type = e.type as string | undefined;

    let asset: ElementAsset | null = null;
    if (type === "blush") {
      warn(`"${id}" type:"blush" → asset:{kind:"gradient"}（颜色曾写死在渲染器里）`);
      asset = { kind: "gradient", shape: "ellipse", color: (e.color as string) ?? V1_BLUSH_COLOR, opacity: 0.5 };
    } else if (e.svgAsset) {
      asset = { kind: "svg-lib", key: e.svgAsset as string };
    } else if (e.text) {
      asset = textAsset(e);
    }
    if (!asset) return [];

    const animations: NonNullable<ElementV2["animations"]> = [];
    const existing = e.animations as ElementV2["animations"];
    if (existing?.length) animations.push(...existing);
    animations.push(...(v1Animations(e) ?? []));

    let offsetY = num(e.offsetY) ?? 0;

    if (type === "tear-pool") {
      warn(`"${id}" type:"tear-pool" → svg-lib + pulse`);
      // v1 渲染器在这里补一个偏移，让泪痕顶端对齐眼睑而不是中心对齐
      if (num(e.offsetY) === undefined) {
        const aspect = e.svgAsset ? getSvgAspect(e.svgAsset as string) : 1;
        offsetY = (num(e.iodScale) ?? 0.28) * aspect * 0.5;
      }
      if (anim?.breathe && !animations.length) {
        animations.push({ preset: "pulse", scaleRange: anim.breathe.scaleRange, period: anim.breathe.period });
      }
    }

    if (type === "trailing-tear") {
      warn(`"${id}" type:"trailing-tear" → svg-lib + emit-fall-fade`);
      const key = `${String(e.landmark)}-${e.mirror ? "r" : "l"}`;
      const seq = trailSeq.get(key) ?? 0;
      trailSeq.set(key, seq + 1);
      const tears = anim?.tears;
      if (tears && tears.period > 0 && !animations.length) {
        animations.push({
          preset: "emit-fall-fade",
          distance: tears.distance,
          period: tears.period,
          phase: (seq * tears.phaseShift) / tears.period,
        });
      }
    }

    // landmark 缺席 = 屏幕空间元素（v1 用 nx/ny 表达）
    const hasLandmark = e.landmark !== undefined;
    const anchor: ElementV2["anchor"] = hasLandmark
      ? {
          space: "face",
          landmark: normalizeLandmark(e.landmark, id, warn),
          offset: [num(e.offsetX) ?? 0, offsetY],
          ...(e.mirror ? { mirror: true } : {}),
        }
      : { space: "screen", nx: num(e.nx) ?? 0.5, ny: num(e.ny) ?? 0.5 };

    // v1 的 face-renderer 在两个分支上对文字的处理是不一样的，这里逐条对齐：
    //   有 landmark → 宽度 = IOD × iodScale，fontSizeW 只影响栅格化清晰度
    //   无 landmark → 直接用纹理的自然像素尺寸，也就是字号 = W × fontSizeW
    // 猜一种统一语义会让 emotions 的标签尺寸变一大截，所以显式写 fit。
    const size: ElementV2["size"] = hasLandmark
      ? { ref: "iod", scale: num(e.iodScale) ?? 0.25, fit: "width" }
      : { ref: "vw", scale: num(e.fontSizeW) ?? num(e.iodScale) ?? 0.05, fit: "font" };

    return [{
      id,
      asset,
      anchor,
      size,
      rotation: num(e.rotation),
      opacity: num(e.opacity),
      animations: animations.length ? animations : undefined,
    }];
  });
}

function normalizeLandmark(v: unknown, id: string, warn: (s: string) => void): string | number {
  if (typeof v === "number") {
    const name = NAME_BY_INDEX.get(v);
    warn(`"${id}" landmark 用了裸编号 ${v}${name ? ` → ${name}` : "（不在锚点表里，原样保留）"}`);
    return name ?? v;
  }
  return v as string;
}

/**
 * 把一份模板原始 JSON 里的元素解析成平铺 ElementV2 列表。
 *
 * v2 走 elements（可含生成器），v1 走 overlay_elements / face_track_elements。
 * 两条路的出口是同一个类型，下游（校验、渲染）只认这一个。
 */
export function migrateElements(raw: Raw): MigrationResult {
  const warnings: string[] = [];
  const warn = (s: string) => {
    if (!warnings.includes(s)) warnings.push(s);
  };

  if (Array.isArray(raw.elements)) {
    return { elements: expandGenerators(raw.elements as ElementOrGenerator[]), warnings };
  }
  if (Array.isArray(raw.overlay_elements)) {
    return { elements: migrateOverlay(raw.overlay_elements as Raw[], warn), warnings };
  }
  if (Array.isArray(raw.face_track_elements)) {
    const anim = raw.face_track_animation as V1FaceAnimation | undefined;
    return { elements: migrateFaceTrack(raw.face_track_elements as Raw[], anim, warn), warnings };
  }
  return { elements: [], warnings };
}
