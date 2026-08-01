import type { Control, TemplateConfig } from "@/engine/types";
import { resolveControls } from "@/engine/resolve";
import { FACE_ANCHORS, ANCHOR_PAIRS } from "@/engine/anchors";
import { HAND_ANCHORS } from "@/engine/hand-anchors";
import { listSvgKeys } from "@/engine/svg-assets";
import { IMPLEMENTED_EFFECTS } from "@/engine/source-effects";
import { sanitizeSvg } from "@/engine/svg-sanitize";
import { migrateElements } from "./migrate";

const SHAPES = ["cloud", "shower", "glass", "cup"];
const PERCEPTIONS = ["segmentation", "face", "hands", "pose"];
const KNOBS = ["gravity", "friction", "streak", "size", "speed", "spread", "splash"];
const MODES = ["absolute", "scale"];
const TEMPLATE_TYPES = ["particle", "overlay", "facetrack"];

export class TemplateError extends Error {
  constructor(slug: string, problems: string[]) {
    super(`模板 "${slug}" 配置有问题：\n  - ${problems.join("\n  - ")}`);
    this.name = "TemplateError";
  }
}

type Raw = Record<string, unknown>;

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function pair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every(num);
}
function triple(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(num);
}

export function validateTemplate(raw: Raw): string[] {
  const p: string[] = [];

  if (typeof raw.slug !== "string" || !/^[a-z0-9-]+$/.test(raw.slug)) {
    p.push("slug 必须是小写字母、数字、连字符组成的字符串");
  }
  const name = raw.name as Raw | undefined;
  if (!name || typeof name.zh !== "string") p.push("name.zh 必填");
  if (typeof raw.category !== "string") p.push("category 必填");
  if (raw.sort_order !== undefined && !num(raw.sort_order)) p.push("sort_order 是数字");
  if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") {
    p.push("hidden 只能是 true/false（true = 不进模板库列表，但 /studio/<slug> 仍可直接访问）");
  }
  if (!num(raw.price_cents) || raw.price_cents < 0) p.push("price_cents 必须是 ≥0 的数字");

  const templateType = (raw.template_type as string) || "particle";
  if (!TEMPLATE_TYPES.includes(templateType)) {
    p.push(`template_type "${templateType}" 不认识，可选：${TEMPLATE_TYPES.join(" / ")}`);
  }

  // overlay 和 facetrack 不需要 emitter/substance/controls
  if (templateType === "overlay" || templateType === "facetrack") {
    validateElementSection(raw, templateType, p);
    validateSource(raw, p);
    return p;
  }

  // particle 类型的完整验证
  const perception = raw.perception;
  if (!Array.isArray(perception) || perception.length === 0) {
    p.push("perception 必须是非空数组");
  } else {
    for (const k of perception) {
      if (!PERCEPTIONS.includes(k as string)) p.push(`perception 里的 "${k}" 不认识`);
    }
  }

  const e = raw.emitter as Raw | undefined;
  if (!e) {
    p.push("emitter 必填");
  } else {
    if (!e.asset && !e.shape) p.push("emitter 要么给 asset 要么给 shape");
    if (e.shape && !SHAPES.includes(e.shape as string)) {
      p.push(`emitter.shape "${e.shape}" 不是内置道具`);
    }
    if (!num(e.aspect) || (e.aspect as number) <= 0) p.push("emitter.aspect 必须是正数");
    const port = e.port as Raw | undefined;
    if (!port || !num(port.x) || !num(port.y)) p.push("emitter.port 需要 {x, y}");
    if (!num(e.band) || (e.band as number) < 0) p.push("emitter.band 必须是 ≥0 的数字");
    if (e.tilt !== undefined && !num(e.tilt)) p.push("emitter.tilt 是弧度数字");
    if (typeof e.draggable !== "boolean") p.push("emitter.draggable 必填 true/false");
    const def = e.default as Raw | undefined;
    if (!def || !num(def.x) || !num(def.y)) p.push("emitter.default 需要 {x, y}");
  }

  const s = raw.substance as Raw | undefined;
  if (!s) {
    p.push("substance 必填");
  } else {
    if (!num(s.gravity)) p.push("substance.gravity 必须是数字");
    if (!num(s.friction) || (s.friction as number) < 0 || (s.friction as number) > 1) {
      p.push("substance.friction 必须在 0~1 之间");
    }
    if (!num(s.streak) || (s.streak as number) < 0) p.push("substance.streak 必须是 ≥0 的数字");
    if (!triple(s.color)) p.push("substance.color 必须是三个 0~1 的数字");
    if (!pair(s.size)) p.push("substance.size 必须是 [最小, 最大]");
    if (!pair(s.speed)) p.push("substance.speed 必须是 [最小, 最大]");
    if (!num(s.spread) || (s.spread as number) < 0) p.push("substance.spread 必须是 ≥0 的弧度");
    if (!num(s.splash) || (s.splash as number) < 0) p.push("substance.splash 必须是 ≥0 的整数");
    if (typeof s.settle !== "boolean") p.push("substance.settle 必填 true/false");
    if (typeof s.twinkle !== "boolean") p.push("substance.twinkle 必填 true/false");
    if (s.blend !== undefined && !["normal", "add"].includes(s.blend as string)) {
      p.push(
        `substance.blend "${s.blend}" 无效，只能是 normal（缺省）或 add。` +
          `add 是发光，只给金粉、火星这类真的在发光的东西 —— 白色的雪用 add 在浅色背景上会消失`,
      );
    }
  }

  const cs = raw.controls;
  if (!Array.isArray(cs) || cs.length === 0) {
    p.push("controls 必须是非空数组");
  } else {
    const seen = new Set<string>();
    for (const [i, c0] of cs.entries()) {
      const c = c0 as Raw;
      const at = `controls[${i}]`;
      if (typeof c.key !== "string" || !c.key) { p.push(`${at}.key 必填`); continue; }
      if (seen.has(c.key)) p.push(`${at}.key "${c.key}" 重复了`);
      seen.add(c.key);
      const lb = c.label as Raw | undefined;
      if (!lb || typeof lb.zh !== "string") p.push(`${at}.label.zh 必填`);
      if (!num(c.min) || !num(c.max) || !num(c.default)) p.push(`${at} 的 min / max / default 都得是数字`);
      else {
        if ((c.min as number) >= (c.max as number)) p.push(`${at}.min 必须小于 max`);
        if ((c.default as number) < (c.min as number) || (c.default as number) > (c.max as number)) {
          p.push(`${at}.default 不在 min~max 范围内`);
        }
      }
      if (c.mode !== undefined && !MODES.includes(c.mode as string)) p.push(`${at}.mode 只能是 absolute 或 scale`);
      const target = c.target as string | undefined;
      if (target !== undefined) {
        const builtin = ["rate", "wind", "stick"].includes(target);
        const sub = target.startsWith("substance.") && KNOBS.includes(target.slice(10));
        if (!builtin && !sub) p.push(`${at}.target "${target}" 无效`);
      } else if (!["rate", "wind", "stick"].includes(c.key)) {
        p.push(`${at} 的 key "${c.key}" 不是内置语义，必须显式声明 target`);
      }
    }
  }

  return p;
}

export function checkWiring(cfg: TemplateConfig): string[] {
  if (cfg.templateType !== "particle" && cfg.templateType !== undefined) return [];
  if (!cfg.substance || !cfg.controls.length) return [];
  const values = Object.fromEntries(cfg.controls.map((c: Control) => [c.key, c.default]));
  const { orphans } = resolveControls(cfg.substance, cfg.controls, values);
  return orphans.map((k) => `滑块 "${k}" 没有绑定任何参数`);
}

/* ============================================================
 * 元素验证
 *
 * 报错风格：一次列出所有问题，每条带 JSON 路径 + 为什么错 + 怎么改。
 * 这份输出是 LLM 写模板时唯一的反馈信号，可读性是硬指标不是锦上添花——
 * 「不在锚点表里」得跟上可选值，「超出范围」得说清超出会怎样。
 * ============================================================ */

const ANCHOR_NAMES = Object.keys(FACE_ANCHORS);
const PAIR_NAMES = Object.keys(ANCHOR_PAIRS);
const ANIM_PRESETS = ["float", "fall", "pulse", "spin", "emit-fall-fade"];
const EASES = ["linear", "in", "out", "inout", "gravity", "bounce"];
/** 只有「0→1 走一趟」的原语能缓动。周期性原语套 ease 会在接缝处顿一下，见 animations.ts */
const EASE_PRESETS = ["fall", "emit-fall-fade"];
const ASSET_KINDS = ["svg-lib", "svg-inline", "text", "gradient", "trail", "stem", "bubbles", "fluidity", "pinch-bloom"];
const FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"];
const HAND_ANCHOR_NAMES = Object.keys(HAND_ANCHORS);
const SIZE_REFS = ["vw", "iod", "eye_width", "face_width", "palm_width"];
const SIZE_FITS = ["width", "font"];
const BLENDS = ["normal", "add", "screen", "multiply"];
const GENERATORS = ["mirrorPair", "trail", "columns", "scatter", "ring", "spread"];
/** 支持 item.jitter 的生成器。columns 是版式（标签逐个对齐），抖了就歪 */
const JITTER_GENERATORS = ["mirrorPair", "trail", "ring", "spread"];
const MASK_PROVIDERS = ["person", "face-ellipse", "none"];
/** schema 认识的 kind。是不是**实现了**另说，见下面的 IMPLEMENTED_EFFECTS */
const EFFECT_KINDS = ["pixelate", "blur", "desaturate", "glitch", "voxel", "mask-debug", "posterize", "pixel-art"];

/** 展开后的元素数硬上限。生成器很容易写出爆炸的数量。 */
const MAX_ELEMENTS = 120;

/** 拼错 key 时给出最接近的几个候选，比单纯说「找不到」有用得多。 */
function nearest(input: string, candidates: string[], n = 3): string[] {
  const dist = (a: string, b: string) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  };
  return [...candidates].sort((x, y) => dist(input, x) - dist(input, y)).slice(0, n);
}

function svgKeys(): string[] {
  try {
    return listSvgKeys();
  } catch {
    return [];
  }
}

function inRange(v: unknown, lo: number, hi: number): boolean {
  return num(v) && (v as number) >= lo && (v as number) <= hi;
}

function validateAnimations(anims: unknown[], at: string, p: string[]) {
  for (const [i, a] of anims.entries()) {
    const aa = a as Raw;
    const path = `${at}.animations[${i}]`;
    if (!aa.preset || !ANIM_PRESETS.includes(aa.preset as string)) {
      p.push(`${path}.preset "${aa.preset}" 无效，可选：${ANIM_PRESETS.join(" / ")}`);
      continue;
    }
    if (!num(aa.period) || (aa.period as number) <= 0) {
      p.push(`${path}.period 必须是正数（秒）。0 或缺失会让动画除零`);
    }
    if (aa.phase !== undefined && !num(aa.phase)) {
      p.push(`${path}.phase 必须是数字，归一化到一个周期（0~1）`);
    }
    if (aa.ease !== undefined) {
      if (!EASES.includes(aa.ease as string)) {
        p.push(`${path}.ease "${aa.ease}" 无效，可选：${EASES.join(" / ")}`);
      } else if (!EASE_PRESETS.includes(aa.preset as string)) {
        p.push(
          `${path}.ease 对 ${aa.preset} 无效 —— 只有 ${EASE_PRESETS.join(" / ")} 支持缓动。` +
            `float / pulse / spin 是周期性的，缓动会在每个周期的接缝处留一个速度拐折`,
        );
      }
    }
    if (aa.preset === "pulse" && !pair(aa.scaleRange)) {
      p.push(`${path}.scaleRange 必须是 [最小, 最大] 两个数字`);
    }
    if (aa.preset === "float" && !num(aa.amplitude)) {
      p.push(`${path}.amplitude 必填，单位是画面高度的比例（0.01 = 1%H）`);
    }
    if (aa.preset === "emit-fall-fade" && !num(aa.distance)) {
      p.push(`${path}.distance 必填，单位 IOD`);
    }
  }
}

/** 沿途叶子。trail 和 stem 共用同一份 schema，别写两遍 */
function validateLeaf(leaf: unknown, at: string, p: string[]) {
  if (leaf === undefined) return;
  const lf = leaf as Raw;
  if (typeof lf !== "object" || lf === null) {
    p.push(`${at}.asset.leaf 形如 { "key": "emoji-leaf", "spacing": 0.9, "scale": 0.34, "seed": 11 }`);
    return;
  }
  const keys = svgKeys();
  if (typeof lf.key !== "string" || (keys.length && !keys.includes(lf.key))) {
    p.push(`${at}.asset.leaf.key "${lf.key}" 不在素材库里。相近的有：${nearest(String(lf.key), keys).join(", ")}`);
  }
  if (!inRange(lf.spacing, 0.05, 5)) p.push(`${at}.asset.leaf.spacing 应在 [0.05, 5]（相邻两片的间距，单位 size.ref）`);
  if (!inRange(lf.scale, 0.02, 3)) p.push(`${at}.asset.leaf.scale 应在 [0.02, 3]`);
  if (!num(lf.seed)) {
    p.push(
      `${at}.asset.leaf.seed 必填。叶子的位置和大小是 hash(第几片, seed) 的纯函数，` +
        `没有 seed 每次长的地方都不一样，golden 对比就不成立`,
    );
  }
}

function validateAsset(a: unknown, at: string, p: string[]) {
  const asset = a as Raw | undefined;
  if (!asset || typeof asset !== "object") {
    p.push(`${at}.asset 必填，形如 { "kind": "svg-lib", "key": "..." }`);
    return;
  }
  const kind = asset.kind as string;
  if (!ASSET_KINDS.includes(kind)) {
    p.push(`${at}.asset.kind "${kind}" 无效，可选：${ASSET_KINDS.join(" / ")}`);
    return;
  }

  if (kind === "svg-lib") {
    const keys = svgKeys();
    if (typeof asset.key !== "string") {
      p.push(`${at}.asset.key 必填。素材库里有：${keys.join(", ")}`);
    } else if (keys.length && !keys.includes(asset.key)) {
      p.push(`${at}.asset.key "${asset.key}" 素材库里没有。相近的有：${nearest(asset.key, keys).join(", ")}`);
    }
  }

  if (kind === "trail") {
    if (typeof asset.color !== "string") p.push(`${at}.asset.color 必填，带的颜色`);
    if (!inRange(asset.seconds, 0.2, 8)) {
      p.push(`${at}.asset.seconds 应在 [0.2, 8]（保留多久的历史，也就是这条带有多长）`);
    }
    validateLeaf(asset.leaf, at, p);
  }

  if (kind === "stem") {
    if (typeof asset.color !== "string") p.push(`${at}.asset.color 必填，茎的颜色`);
    if (typeof asset.finger !== "string" || !FINGER_NAMES.includes(asset.finger)) {
      p.push(
        `${at}.asset.finger 必填，是驱动这根茎的手指。可选：${FINGER_NAMES.join(" / ")}。` +
          `不写的话茎永远不会长 —— 长度完全由这根手指的弯曲度决定`,
      );
    }
    if (asset.bow !== undefined && !inRange(asset.bow, 0, 0.4)) {
      p.push(`${at}.asset.bow 应在 [0, 0.4]（弯曲程度，占画面宽度的比例；0 = 笔直的竖线）`);
    }
    if (asset.segments !== undefined && !inRange(asset.segments, 4, 64)) {
      p.push(`${at}.asset.segments 应在 [4, 64]`);
    }
    if (!num(asset.seed)) {
      p.push(`${at}.asset.seed 必填。它定弯的方向和叶子的左右，没它同一个模板每次加载都不一样`);
    }
    validateLeaf(asset.leaf, at, p);
    if (asset.flower !== undefined) {
      const fl = asset.flower as Raw;
      if (typeof fl !== "object" || fl === null) {
        p.push(`${at}.asset.flower 形如 { "key": "emoji-sunflower", "scale": 0.55 }`);
      } else {
        const keys = svgKeys();
        if (typeof fl.key !== "string" || (keys.length && !keys.includes(fl.key))) {
          p.push(`${at}.asset.flower.key "${fl.key}" 不在素材库里。相近的有：${nearest(String(fl.key), keys).join(", ")}`);
        }
        if (!inRange(fl.scale, 0.02, 3)) p.push(`${at}.asset.flower.scale 应在 [0.02, 3]`);
      }
    }
  }

  if (kind === "fluidity") {
    if (!inRange(asset.boxes, 1, 200)) p.push(`${at}.asset.boxes 应在 [1, 200]（最多几个框）`);
    if (!inRange(asset.lines, 0, 400)) p.push(`${at}.asset.lines 应在 [0, 400]（最多几条线）`);
    if (!inRange(asset.detectHz, 1, 60)) {
      p.push(`${at}.asset.detectHz 应在 [1, 60]（每秒重检测几次。这是「一帧一检测」那种跳动的节奏）`);
    }
    if (!inRange(asset.jitter, 0, 2)) p.push(`${at}.asset.jitter 应在 [0, 2]（框位置抖动，相对肩宽）`);
    if (!pair(asset.boxScale)) {
      p.push(`${at}.asset.boxScale 必须是 [最小, 最大]，相对肩宽`);
    } else {
      const [lo, hi] = asset.boxScale as [number, number];
      if (!inRange(lo, 0.01, 3) || !inRange(hi, 0.01, 3)) p.push(`${at}.asset.boxScale 两端都应在 [0.01, 3]`);
      if (lo > hi) p.push(`${at}.asset.boxScale 的最小值大于最大值了`);
    }
    if (!inRange(asset.digits, 1, 8)) p.push(`${at}.asset.digits 应在 [1, 8]（编号位数，参考素材是 5）`);
    if (typeof asset.color !== "string") p.push(`${at}.asset.color 必填`);
    if (!num(asset.seed)) {
      p.push(
        `${at}.asset.seed 必填。编号和抖动都是 hash(第几个, 第几个检测帧, seed) 的纯函数 —— ` +
          `用随机数的话 renderAt(t) 不再确定，整套渲染回归就不成立了`,
      );
    }
  }

  if (kind === "bubbles") {
    if (!inRange(asset.count, 1, 120)) p.push(`${at}.asset.count 应在 [1, 120]（同时最多几个）`);
    if (!inRange(asset.rise, 0.01, 1)) p.push(`${at}.asset.rise 应在 [0.01, 1]（每秒走过画面高度的比例）`);
    if (!pair(asset.size)) {
      p.push(`${at}.asset.size 必须是 [最小, 最大]，占画面宽度的比例`);
    } else {
      const [lo, hi] = asset.size as [number, number];
      if (!inRange(lo, 0.005, 0.5) || !inRange(hi, 0.005, 0.5)) p.push(`${at}.asset.size 的两端都应在 [0.005, 0.5]`);
      if (lo > hi) p.push(`${at}.asset.size 的最小值大于最大值了`);
    }
    if (!inRange(asset.wobble, 0, 0.3)) p.push(`${at}.asset.wobble 应在 [0, 0.3]（横向摆动幅度）`);
    if (!inRange(asset.popRadius, 0.2, 4)) {
      p.push(`${at}.asset.popRadius 应在 [0.2, 4]（戳破判定半径，相对泡泡半径。>1 是因为指尖 landmark 本身有抖动）`);
    }
    if (!inRange(asset.refraction, 0, 1)) p.push(`${at}.asset.refraction 应在 [0, 1]（把背后画面推开多少）`);
    if (!inRange(asset.iridescence, 0, 2)) p.push(`${at}.asset.iridescence 应在 [0, 2]（边缘彩虹强度）`);
    if (!num(asset.seed)) {
      p.push(
        `${at}.asset.seed 必填。冒泡的位置、大小、速度都是 hash(第几个, seed) 的纯函数 —— ` +
          `用随机数的话 renderAt(t) 不再确定，整套渲染回归就不成立了`,
      );
    }
  }

  if (kind === "pinch-bloom") {
    const keys = svgKeys();
    if (typeof asset.key !== "string" || (keys.length && !keys.includes(asset.key))) {
      p.push(`${at}.asset.key "${asset.key}" 不在素材库里。相近的有：${nearest(String(asset.key), keys).join(", ")}`);
    }
    if (!inRange(asset.seconds, 0.2, 6)) p.push(`${at}.asset.seconds 应在 [0.2, 6]（一朵活多久）`);
    if (!inRange(asset.grow, 0.05, 4)) p.push(`${at}.asset.grow 应在 [0.05, 4]（最终大小相对 size.ref）`);
  }

  if (kind === "svg-inline") {
    if (typeof asset.svg !== "string") {
      p.push(`${at}.asset.svg 必填，内联 SVG 字符串`);
    } else {
      // 拒收而不是静默清洗：LLM 需要看到具体哪一处不合法才能改
      for (const problem of sanitizeSvg(asset.svg)) {
        p.push(`${at}.asset.svg 不安全：${problem}。修掉它，不要绕过`);
      }
      if (!/viewBox\s*=/.test(asset.svg)) {
        p.push(`${at}.asset.svg 缺 viewBox。高宽比从 viewBox 解析，没有就只能按 1:1 画`);
      }
      if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(asset.svg)) {
        p.push(
          `${at}.asset.svg 缺 xmlns="http://www.w3.org/2000/svg"。` +
            `内联 SVG 是当图片加载的（Blob → Image），没有命名空间浏览器直接拒绝解析 —— ` +
            `不在这里拦住的话，运行时只会抛一句 "SVG rasterization failed"，不告诉你是哪个元素`,
        );
      }
    }
  }

  if (kind === "text" && typeof asset.text !== "string") {
    p.push(`${at}.asset.text 必填`);
  }

  if (kind === "gradient") {
    if (asset.shape !== "ellipse") p.push(`${at}.asset.shape 目前只支持 "ellipse"`);
    if (typeof asset.color !== "string") p.push(`${at}.asset.color 必填，如 "rgba(242,147,126,0.5)"`);
    if (asset.opacity !== undefined && !inRange(asset.opacity, 0, 1)) {
      p.push(`${at}.asset.opacity 应在 [0, 1]`);
    }
  }
}

function validateAnchor(a: unknown, at: string, p: string[]) {
  const anchor = a as Raw | undefined;
  if (!anchor || typeof anchor !== "object") {
    p.push(`${at}.anchor 必填，形如 { "space": "face", "landmark": "cheek_left" } 或 { "space": "screen", "nx": 0.5, "ny": 0.5 }`);
    return;
  }
  const space = anchor.space as string;

  if (space === "screen") {
    for (const k of ["nx", "ny"] as const) {
      if (!inRange(anchor[k], -0.2, 1.2)) {
        p.push(`${at}.anchor.${k} 应在 [-0.2, 1.2]。0~1 是画面内，留一点余量给出画的元素`);
      }
    }
    return;
  }

  if (space === "face") {
    const lm = anchor.landmark;
    if (typeof lm === "number") {
      p.push(`${at}.anchor.landmark 不能写裸编号 ${lm}。数字是引擎内部实现，JSON 只写语义名。可选：${ANCHOR_NAMES.join(", ")}`);
    } else if (typeof lm !== "string") {
      p.push(`${at}.anchor.landmark 必填，写语义名。可选：${ANCHOR_NAMES.join(", ")}`);
    } else if (!ANCHOR_NAMES.includes(lm)) {
      p.push(`${at}.anchor.landmark "${lm}" 不在锚点表里。相近的有：${nearest(lm, ANCHOR_NAMES).join(", ")}`);
    }
    if (anchor.offset !== undefined && !pair(anchor.offset)) {
      p.push(`${at}.anchor.offset 必须是 [x, y] 两个数字，单位 IOD`);
    }
    return;
  }

  if (space === "hand") {
    if (anchor.hand !== "left" && anchor.hand !== "right") {
      p.push(
        `${at}.anchor.hand 必填，只能是 "left" 或 "right"。` +
          `说的是**本人的**左右手，不是画面上的左右 —— 画面是镜像的，本人的左手出现在屏幕右侧`,
      );
    }
    const lm = anchor.landmark;
    if (typeof lm === "number") {
      p.push(
        `${at}.anchor.landmark 不能写裸编号 ${lm}。数字是引擎内部实现，JSON 只写语义名。` +
          `可选：${HAND_ANCHOR_NAMES.join(", ")}`,
      );
    } else if (typeof lm !== "string") {
      p.push(`${at}.anchor.landmark 必填，写语义名。可选：${HAND_ANCHOR_NAMES.join(", ")}`);
    } else if (!HAND_ANCHOR_NAMES.includes(lm)) {
      p.push(`${at}.anchor.landmark "${lm}" 不在手部锚点表里。相近的有：${nearest(lm, HAND_ANCHOR_NAMES).join(", ")}`);
    }
    if (anchor.offset !== undefined && !pair(anchor.offset)) {
      p.push(`${at}.anchor.offset 必须是 [x, y] 两个数字，单位是掌宽`);
    }
    return;
  }

  p.push(`${at}.anchor.space "${space}" 无效，只能是 "screen" / "face" / "hand"`);
}

function validateSize(s: unknown, at: string, p: string[]) {
  const size = s as Raw | undefined;
  if (!size || typeof size !== "object") {
    p.push(`${at}.size 必填，形如 { "ref": "iod", "scale": 0.25 }`);
    return;
  }
  if (!SIZE_REFS.includes(size.ref as string)) {
    p.push(`${at}.size.ref "${size.ref}" 无效，可选：${SIZE_REFS.join(" / ")}`);
  }
  if (size.fit !== undefined && !SIZE_FITS.includes(size.fit as string)) {
    p.push(
      `${at}.size.fit "${size.fit}" 无效，可选：${SIZE_FITS.join(" / ")}。` +
        `width = scale 量的是元素宽度；font = 量的是字号（只对 text 有意义）`,
    );
  }
  if (!num(size.scale) || (size.scale as number) <= 0 || (size.scale as number) > 3) {
    p.push(
      `${at}.size.scale = ${size.scale} 超出范围 (0, 3]。` +
        `${size.ref === "iod" ? "iod 参照下 3 意味着贴纸宽度是瞳距的 3 倍，几乎必然出画" : "超过 3 倍参照物基本一定出画"}`,
    );
  }
}

/** 平铺元素（非生成器）。 */
function validateElement(e: Raw, at: string, p: string[], ids: Set<string>) {
  if (typeof e.id !== "string" || !e.id) {
    p.push(`${at}.id 必填，模板内唯一`);
  } else if (ids.has(e.id)) {
    p.push(`${at}.id "${e.id}" 和前面的元素重复了`);
  } else {
    ids.add(e.id);
  }
  validateAsset(e.asset, at, p);
  validateAnchor(e.anchor, at, p);
  const assetKind = (e.asset as Raw | undefined)?.kind;
  const space = (e.anchor as Raw | undefined)?.space;
  if (assetKind === "pinch-bloom" && space !== "hand") {
    p.push(
      `${at} 的 asset 是 pinch-bloom 但锚不在 hand 空间 —— 捏合是手的动作，` +
        `要靠拇指尖和食指尖的距离判定，别的空间没有这两个点`,
    );
  }
  if (assetKind === "fluidity" && space !== "screen") {
    p.push(
      `${at} 的 asset 是 fluidity 但锚不在 screen 空间 —— 它是满屏的效果，` +
        `框挂在全身关节上，不挂在某一个锚点。写 { "space": "screen", "nx": 0.5, "ny": 0.5 }`,
    );
  }
  if (assetKind === "bubbles" && space !== "screen") {
    p.push(
      `${at} 的 asset 是 bubbles 但锚不在 screen 空间 —— 它是满屏的模拟，` +
        `不挂在任何一个点上。写 { "space": "screen", "nx": 0.5, "ny": 0.5 }`,
    );
  }
  if (assetKind === "stem" && space !== "hand") {
    p.push(
      `${at} 的 asset 是 stem 但锚不在 hand 空间 —— 茎的长度由手指弯曲度决定，` +
        `别的空间没有手指。要「从底边长到某个点」而不看手，用 trail 或者普通贴纸`,
    );
  }
  if (assetKind === "trail" && space === "screen") {
    p.push(
      `${at} 的 asset 是 trail 但锚在 screen 空间 —— 屏幕上的固定点没有轨迹，画不出任何东西。` +
        `轨迹要锚在会动的东西上（space "hand" 或 "face"）`,
    );
  }
  validateSize(e.size, at, p);
  if (e.opacity !== undefined && !inRange(e.opacity, 0, 1)) p.push(`${at}.opacity 应在 [0, 1]`);
  if (e.interactive !== undefined) {
    const it = e.interactive as Raw;
    if (typeof it !== "object" || it === null) {
      p.push(`${at}.interactive 形如 { "drag": true, "resize": true }`);
    } else {
      for (const k of ["drag", "resize"] as const) {
        if (it[k] !== undefined && typeof it[k] !== "boolean") p.push(`${at}.interactive.${k} 只能是 true/false`);
      }
      const anchor = e.anchor as Raw | undefined;
      if (anchor?.space === "face") {
        p.push(`${at}.interactive 对 face 空间元素无效——位置由 landmark 决定，用户拖完下一帧就被拉回去`);
      }
    }
  }
  if (e.rotation !== undefined && !num(e.rotation)) p.push(`${at}.rotation 必须是数字（度）`);
  validateBlend(e.blend, at, p);
  if (e.animations !== undefined) {
    if (!Array.isArray(e.animations)) p.push(`${at}.animations 必须是数组`);
    else validateAnimations(e.animations, at, p);
  }
}

function validateBlend(b: unknown, at: string, p: string[]) {
  if (b === undefined) return;
  if (!BLENDS.includes(b as string)) {
    p.push(
      `${at}.blend "${b}" 无效，可选：${BLENDS.join(" / ")}` +
        `（multiply 让腮红贴到皮肤上，screen 让眼泪透出底色，add 用来发光）`,
    );
  }
}

/** 逐实例抖动。scatter 自己有 seed，不走这条。 */
function validateJitter(j: unknown, at: string, generator: string, p: string[]) {
  if (typeof j !== "object" || j === null || Array.isArray(j)) {
    p.push(`${at}.jitter 必须是对象，形如 { "size": 0.2, "phase": 0.15, "seed": 7 }`);
    return;
  }
  if (!JITTER_GENERATORS.includes(generator)) {
    p.push(
      `${at}.jitter 对 ${generator} 无效，只有 ${JITTER_GENERATORS.join(" / ")} 支持。` +
        `scatter 本来就是随机的，用它自己的 seed / sizeRange`,
    );
  }
  const jj = j as Raw;
  if (!num(jj.seed)) {
    p.push(`${at}.jitter.seed 必填。没有 seed 每次展开抖出来的都不一样，渲染回归的 golden 对比就不成立`);
  }
  for (const k of ["size", "phase"] as const) {
    if (jj[k] !== undefined && !num(jj[k])) p.push(`${at}.jitter.${k} 必须是数字（随机范围的半宽，0.2 = ±20%）`);
  }
  if (jj.offset !== undefined && !pair(jj.offset)) {
    p.push(`${at}.jitter.offset 必须是 [x, y]，单位 IOD`);
  }
  if (jj.size === undefined && jj.phase === undefined && jj.offset === undefined) {
    p.push(`${at}.jitter 至少要给 size / phase / offset 中的一个，否则它什么都不做`);
  }
}

/** 生成器。item 走元素的 asset/size/animations 检查，anchor 由生成器自己填。 */
function validateGenerator(g: Raw, at: string, p: string[]) {
  const kind = g.generate as string;
  if (!GENERATORS.includes(kind)) {
    p.push(`${at}.generate "${kind}" 无效，可选：${GENERATORS.join(" / ")}`);
    return;
  }

  const item = g.item as Raw | undefined;
  if (!item) {
    p.push(`${at}.item 必填，描述被复制出来的那个元素长什么样`);
  } else {
    validateAsset(item.asset, `${at}.item`, p);
    // scatter 的 size 可以省，由 sizeRange 决定
    if (item.size !== undefined || kind !== "scatter") validateSize(item.size, `${at}.item`, p);
    if (item.animations !== undefined) {
      if (!Array.isArray(item.animations)) p.push(`${at}.item.animations 必须是数组`);
      else validateAnimations(item.animations, `${at}.item`, p);
    }
    if (item.id !== undefined) p.push(`${at}.item.id 不要写，生成器负责发 id`);
    if (item.anchor !== undefined) p.push(`${at}.item.anchor 不要写，生成器负责填 anchor`);
    validateBlend(item.blend, `${at}.item`, p);
    if (item.jitter !== undefined) validateJitter(item.jitter, `${at}.item`, kind, p);
  }

  switch (kind) {
    case "mirrorPair": {
      if (!PAIR_NAMES.includes(g.anchor as string)) {
        p.push(`${at}.anchor "${g.anchor}" 不是成对锚点。可选：${PAIR_NAMES.join(" / ")}（写 lower_eyelid，不是 lower_eyelid_left）`);
      }
      if (g.offset !== undefined && !pair(g.offset)) p.push(`${at}.offset 必须是 [x, y]`);
      if (g.children !== undefined) {
        if (!Array.isArray(g.children)) p.push(`${at}.children 必须是数组`);
        else g.children.forEach((c, i) => validateGenerator(c as Raw, `${at}.children[${i}]`, p));
      }
      break;
    }
    case "trail":
      if (!num(g.count) || (g.count as number) < 1) p.push(`${at}.count 必须是 ≥1 的整数`);
      if (!num(g.step)) p.push(`${at}.step 必填，相邻两个的 y 间距，单位 IOD`);
      // 顶层 trail 不写 landmark 会静默挂到 nose_bridge 上 —— 校验过、渲染出来，
      // 只是长在鼻梁上。这类「不报错但位置全错」的失效最难查，所以这里直接拦掉
      if (g.landmark !== undefined && !ANCHOR_NAMES.includes(g.landmark as string)) {
        p.push(
          `${at}.landmark "${String(g.landmark)}" 不在锚点表里。` +
            `相近的有：${nearest(String(g.landmark), ANCHOR_NAMES).join(", ")}`,
        );
      }
      break;
    case "columns":
      if (!num(g.rows) || (g.rows as number) < 1) p.push(`${at}.rows 必须是 ≥1 的整数`);
      if (!["both", "left", "right"].includes(g.sides as string)) p.push(`${at}.sides 只能是 both / left / right`);
      if (!pair(g.startOffset)) p.push(`${at}.startOffset 必须是 [x, y]（注意是 startOffset 不是 start）`);
      if (!num(g.stepY)) p.push(`${at}.stepY 必填`);
      break;
    case "scatter":
      if (!num(g.count) || (g.count as number) < 1) p.push(`${at}.count 必须是 ≥1 的整数（是标量，不是区间）`);
      if (!num(g.seed)) {
        p.push(`${at}.seed 必填。没有 seed 每次展开的位置都不一样，渲染回归的 golden 对比就不成立`);
      }
      if (g.sizeRange !== undefined && !pair(g.sizeRange)) p.push(`${at}.sizeRange 必须是 [最小, 最大]`);
      break;
    case "ring":
      if (!num(g.count) || (g.count as number) < 1) p.push(`${at}.count 必须是 ≥1 的整数`);
      if (!num(g.radius)) p.push(`${at}.radius 必填，单位 IOD`);
      if (g.arc !== undefined && !pair(g.arc)) p.push(`${at}.arc 必须是 [起始角, 结束角]，度`);
      break;
    case "spread":
      if (!num(g.count) || (g.count as number) < 1) p.push(`${at}.count 必须是 ≥1 的整数`);
      if (!num(g.width)) p.push(`${at}.width 必填，总宽度，单位 IOD`);
      break;
  }
}

/**
 * elements 段。v2 走这里；只有 overlay_elements / face_track_elements 的旧模板
 * 交给兼容层转换后再校验一次，避免在这里维护第二套 v1 规则。
 */
function validateElementSection(raw: Raw, templateType: string, p: string[]) {
  const v2 = raw.elements;
  const v1 = raw.overlay_elements ?? raw.face_track_elements;

  // 只有帧效果、没有贴纸是合法的：「只有我是彩色的」不需要任何元素。
  // 这时空 elements 不是「什么都不会显示」，而是这个模板的全部内容都在 source 里。
  const sourceOnly = Boolean(raw.source);

  if (!Array.isArray(v2)) {
    if (!Array.isArray(v1) || v1.length === 0) {
      if (sourceOnly) return;
      p.push(
        `${templateType} 类型需要 elements 数组（v2）。` +
          `旧模板的 ${templateType === "overlay" ? "overlay_elements" : "face_track_elements"} 仍受支持，但会走兼容层并打警告`,
      );
      return;
    }
    // v1：只做转换后的校验，转换失败本身就是错误
    validateMigrated(raw, p);
    return;
  }

  if (v2.length === 0) {
    if (sourceOnly) return;
    p.push("elements 是空数组，而且没有 source 帧效果，这个模板什么都不会显示");
    return;
  }

  const ids = new Set<string>();
  for (const [i, e0] of v2.entries()) {
    const e = e0 as Raw;
    const at = `elements[${i}]`;
    if (typeof e.generate === "string") validateGenerator(e, at, p);
    else validateElement(e, at, p, ids);
  }

  /*
   * 用了手部锚点或掌宽就必须声明 perception: ["hands"]。
   *
   * 和 mask.provider "person" 要求 "segmentation" 是同一条规矩，但这一条尤其重要：
   * "hands" 曾经是个**静默失效的枚举值** —— types.ts 和 validate.ts 都认它，
   * 而 engine.perceive() 没有对应分支，模板写了能过校验、能渲染、什么都不发生。
   * 现在感知实现了，反过来要防的是「用了手部锚点却忘了声明感知」，
   * 表现同样是静默的：元素永远解不出锚点，永远隐藏。
   */
  const needsHands = v2.some((e0) => {
    const e = e0 as Raw;
    const anchor = (e.anchor ?? (e.item as Raw | undefined)?.anchor) as Raw | undefined;
    const size = (e.size ?? (e.item as Raw | undefined)?.size) as Raw | undefined;
    return anchor?.space === "hand" || size?.ref === "palm_width";
  });
  if (needsHands) {
    const perception = raw.perception;
    if (!Array.isArray(perception) || !perception.includes("hands")) {
      p.push(
        '用了手部锚点（anchor.space "hand"）或掌宽（size.ref "palm_width"）时，' +
          'perception 必须包含 "hands"，否则手部模型不会被加载，元素永远隐藏',
      );
    }
  }

  // 展开后再校验一次：展开本身就能暴露一半问题（空展开、数量爆炸、生成器填出越界锚点）。
  // 平铺元素上面已经逐个查过了，这里跳过它们，否则同一个问题会报两遍。
  validateMigrated(raw, p, ids);
}

/** 跑一遍真正的展开/转换，对结果做数量和完整性检查。 */
function validateMigrated(raw: Raw, p: string[], alreadyChecked = new Set<string>()) {
  const ids = new Set<string>();
  let expanded;
  try {
    expanded = migrateElements(raw).elements;
  } catch (e) {
    p.push(`元素展开失败：${(e as Error).message}`);
    return;
  }

  if (expanded.length === 0) {
    p.push("展开后一个元素都没有。检查生成器的 count / anchor 是不是写错了");
    return;
  }
  if (expanded.length > MAX_ELEMENTS) {
    p.push(`展开后有 ${expanded.length} 个元素，上限 ${MAX_ELEMENTS}。调小生成器的 count`);
  }

  for (const [i, el] of expanded.entries()) {
    const at = `展开后 elements[${i}]（id=${el.id}）`;
    if (ids.has(el.id)) p.push(`${at} 的 id 重复`);
    ids.add(el.id);
    if (alreadyChecked.has(el.id)) continue;
    validateAnchor(el.anchor as unknown as Raw, at, p);
    validateSize(el.size as unknown as Raw, at, p);
  }
}

/* ---- 帧效果 ---- */

function validateSource(raw: Raw, p: string[]) {
  const s = raw.source as Raw | undefined;
  if (!s) return;

  const mask = s.mask as Raw | undefined;
  if (!mask) {
    p.push("source.mask 必填");
  } else {
    const provider = mask.provider as string;
    if (!MASK_PROVIDERS.includes(provider)) {
      p.push(`source.mask.provider "${provider}" 无效，可选：${MASK_PROVIDERS.join(" / ")}`);
    }
    if (provider === "face-ellipse") {
      p.push("source.mask.provider \"face-ellipse\" 目前只留了枚举值没有实现。本仓库分割模型已经在跑，用 \"person\"");
    }
    if (provider === "person") {
      const perception = raw.perception;
      if (!Array.isArray(perception) || !perception.includes("segmentation")) {
        p.push('source.mask.provider 是 "person" 时，perception 必须包含 "segmentation"，否则分割模型不会被加载');
      }
    }
    if (mask.exclude !== undefined) {
      if (mask.exclude !== "face") {
        p.push(`source.mask.exclude "${mask.exclude}" 无效，目前只支持 "face"（用人脸 landmark 的包围椭圆保护脸部）`);
      } else {
        const perception = raw.perception;
        if (!Array.isArray(perception) || !perception.includes("face")) {
          p.push('source.mask.exclude 是 "face" 时，perception 必须包含 "face"，否则人脸模型不会被加载');
        }
      }
    }
    if (mask.excludePadding !== undefined && !inRange(mask.excludePadding, 0.5, 2)) {
      p.push("source.mask.excludePadding 应在 [0.5, 2]。1 = 刚好包住 landmark（只覆盖皮肤，不含头发）");
    }
    if (mask.feather !== undefined && !inRange(mask.feather, 0, 0.1)) {
      p.push("source.mask.feather 应在 [0, 0.1]");
    }
    if (mask.onLost !== undefined && !["clear", "hold", "full"].includes(mask.onLost as string)) {
      p.push("source.mask.onLost 只能是 clear / hold / full");
    }
  }

  if (!["inside", "outside"].includes(s.apply as string)) {
    p.push(`source.apply "${s.apply}" 无效，只能是 inside（效果作用在人身上）或 outside（作用在背景上）`);
  }

  const eff = s.effect as Raw | undefined;
  if (!eff) {
    p.push("source.effect 必填");
    return;
  }
  const kind = eff.kind as string;
  if (!EFFECT_KINDS.includes(kind)) {
    p.push(`source.effect.kind "${kind}" 无效，可选：${EFFECT_KINDS.join(" / ")}`);
    return;
  }
  /*
   * 「引擎实现了没有」直接问引擎，不在这里手抄一份名单。
   *
   * 抄一份的下场已经发生过一次：blur 在这里是合法 kind、radius 也校验了，
   * 但 setupSourceEffect 只认 pixelate，于是声明 blur 的模板能过校验、能正常渲染、
   * 什么效果都没有、且不报任何错。对 LLM 生成模板尤其致命 —— 全套 gate 绿灯放行，
   * 产出一个「没效果」的模板。
   */
  if (!IMPLEMENTED_EFFECTS.includes(kind)) {
    p.push(
      `source.effect.kind "${kind}" 只留了枚举值没有实现，装上去不会有任何效果。` +
        `已实现的：${IMPLEMENTED_EFFECTS.join(" / ")}`,
    );
  }
  if ((kind === "pixelate" || kind === "pixel-art") && !inRange(eff.blocks, 4, 200)) {
    p.push("source.effect.blocks 应在 [4, 200]（短边分几格）。注意它和菜单上写的 240p 没有换算关系");
  }
  if (kind === "blur" && !inRange(eff.radius, 0.001, 0.1)) {
    p.push("source.effect.radius 应在 [0.001, 0.1]，单位是长边的比例（0.01 ≈ 长边的 1%）");
  }
  if (kind === "desaturate" && !inRange(eff.amount, 0, 1)) {
    p.push("source.effect.amount 应在 [0, 1]，1 = 全灰");
  }
  if (kind === "glitch") {
    if (!inRange(eff.blocks, 8, 200)) p.push("source.effect.blocks 应在 [8, 200]（短边分几行，错位块的粒度）");
    for (const [k, hi, hint] of [
      ["displace", 0.5, "横向错位强度，画面宽度的比例"],
      ["channelSplit", 0.05, "RGB 通道分离量，画面宽度的比例"],
      ["scanline", 1, "扫描线强度"],
      ["colorNoise", 1, "色块乱码密度"],
      ["darkBias", 1, "噪声往暗部集中的程度。0 = 脸上也花"],
    ] as const) {
      if (!inRange(eff[k], 0, hi)) p.push(`source.effect.${k} 应在 [0, ${hi}]（${hint}）`);
    }
    if (!inRange(eff.speed, 0.1, 60)) p.push("source.effect.speed 应在 [0.1, 60]（每秒变几次）");
    if (!num(eff.seed)) {
      p.push(
        "source.effect.seed 必填。损坏必须是 hash(块, 帧号, seed) 的纯函数 —— " +
          "用随机数的话 renderAt(t) 不再确定，整套渲染回归就不成立了",
      );
    }
  }

  if (kind === "voxel") {
    if (!inRange(eff.blocks, 8, 200)) p.push("source.effect.blocks 应在 [8, 200]（短边分几格）");
    for (const [k, hi, hint] of [
      ["palette", 1, "往 Minecraft 方块色靠拢的强度。0 = 只方块化不改色"],
      ["faceShade", 1, "立方体的面：顶边提亮 / 底边压暗"],
      ["outline", 1, "块间接缝压暗多少"],
    ] as const) {
      if (!inRange(eff[k], 0, hi)) p.push(`source.effect.${k} 应在 [0, ${hi}]（${hint}）`);
    }
    if (!inRange(eff.levels, 2, 32)) p.push("source.effect.levels 应在 [2, 32]（每通道量化到几级）");
    if (eff.saturate !== undefined && !inRange(eff.saturate, 0, 2)) {
      p.push("source.effect.saturate 应在 [0, 2]（量化前先提多少饱和度）");
    }
    if (eff.grain !== undefined && !inRange(eff.grain, 0, 1)) p.push("source.effect.grain 应在 [0, 1]（块内颗粒）");
    if (eff.smooth !== undefined && !inRange(eff.smooth, 0, 1)) {
      p.push("source.effect.smooth 应在 [0, 1]（用多大范围的颜色填一个块。和 blocks 是两个独立的选择）");
    }
    if (eff.ambient !== undefined && !inRange(eff.ambient, 0, 0.6)) {
      p.push("source.effect.ambient 应在 [0, 0.6]（暗部地板。MC 的世界里没有纯黑）");
    }
    if (!num(eff.seed)) {
      p.push(
        "source.effect.seed 必填。块内颗粒是 hash(块坐标, seed) 的纯函数 —— " +
          "用随机数的话 renderAt(t) 不再确定，整套渲染回归就不成立了",
      );
    }
  }
}
