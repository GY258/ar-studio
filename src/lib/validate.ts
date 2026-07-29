import type { Control, TemplateConfig } from "@/engine/types";
import { resolveControls } from "@/engine/resolve";
import { FACE_ANCHORS, ANCHOR_PAIRS } from "@/engine/anchors";
import { listSvgKeys } from "@/engine/svg-assets";
import { sanitizeSvg } from "@/engine/svg-sanitize";
import { migrateElements } from "./migrate";

const SHAPES = ["cloud", "shower", "glass", "cup"];
const PERCEPTIONS = ["segmentation", "face", "hands"];
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
const ASSET_KINDS = ["svg-lib", "svg-inline", "text", "gradient"];
const SIZE_REFS = ["vw", "iod", "eye_width", "face_width"];
const SIZE_FITS = ["width", "font"];
const BLENDS = ["normal", "add", "screen", "multiply"];
const GENERATORS = ["mirrorPair", "trail", "columns", "scatter", "ring", "spread"];
/** 支持 item.jitter 的生成器。columns 是版式（标签逐个对齐），抖了就歪 */
const JITTER_GENERATORS = ["mirrorPair", "trail", "ring", "spread"];
const MASK_PROVIDERS = ["person", "face-ellipse", "none"];
const EFFECT_KINDS = ["pixelate", "blur", "posterize", "pixel-art"];

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

  p.push(`${at}.anchor.space "${space}" 无效，只能是 "screen" 或 "face"`);
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

  if (!Array.isArray(v2)) {
    if (!Array.isArray(v1) || v1.length === 0) {
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
    p.push("elements 是空数组，这个模板什么都不会显示");
    return;
  }

  const ids = new Set<string>();
  for (const [i, e0] of v2.entries()) {
    const e = e0 as Raw;
    const at = `elements[${i}]`;
    if (typeof e.generate === "string") validateGenerator(e, at, p);
    else validateElement(e, at, p, ids);
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
  if (kind === "posterize" || kind === "pixel-art") {
    p.push(`source.effect.kind "${kind}" 目前只留了接口没有实现，本轮只有 pixelate 能跑`);
  }
  if ((kind === "pixelate" || kind === "pixel-art") && !inRange(eff.blocks, 4, 200)) {
    p.push("source.effect.blocks 应在 [4, 200]（短边分几格）。注意它和菜单上写的 240p 没有换算关系");
  }
  if (kind === "blur" && (!num(eff.radius) || (eff.radius as number) <= 0)) {
    p.push("source.effect.radius 必须是正数");
  }
}
