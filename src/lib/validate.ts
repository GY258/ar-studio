import type { Control, TemplateConfig } from "@/engine/types";
import { resolveControls } from "@/engine/resolve";

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

  // overlay 和 facetrack 不需要 perception/emitter/substance/controls
  if (templateType === "overlay") {
    if (!Array.isArray(raw.overlay_elements) || raw.overlay_elements.length === 0) {
      p.push("overlay 类型需要 overlay_elements 数组");
    }
    return p;
  }

  if (templateType === "facetrack") {
    if (!Array.isArray(raw.face_track_elements) || raw.face_track_elements.length === 0) {
      p.push("facetrack 类型需要 face_track_elements 数组");
    }
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
