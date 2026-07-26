import type { Control, TemplateConfig } from "@/engine/types";
import { resolveControls } from "@/engine/resolve";

/**
 * 模板 JSON 的校验。
 *
 * 存在的理由很实际：模板要靠持续增加来撑增长，写模板的人（可能是运营、
 * 也可能是未来的投稿者）不会读引擎代码。一个拼错的字段如果静默通过，
 * 表现是「这个模板打开就是黑屏」，排查成本极高。宁可加载时就吵。
 */

const SHAPES = ["cloud", "shower", "glass", "cup"];
const PERCEPTIONS = ["segmentation", "face", "hands"];
const KNOBS = ["gravity", "friction", "streak", "size", "speed", "spread", "splash"];
const MODES = ["absolute", "scale"];

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

/** 返回问题清单，空数组表示通过。 */
export function validateTemplate(raw: Raw): string[] {
  const p: string[] = [];

  if (typeof raw.slug !== "string" || !/^[a-z0-9-]+$/.test(raw.slug)) {
    p.push("slug 必须是小写字母、数字、连字符组成的字符串（它会出现在 URL 里）");
  }
  const name = raw.name as Raw | undefined;
  if (!name || typeof name.zh !== "string") p.push("name.zh 必填");
  if (typeof raw.category !== "string") p.push("category 必填");
  if (raw.sort_order !== undefined && !num(raw.sort_order)) p.push("sort_order 是数字，小的排前面");
  if (!num(raw.price_cents) || raw.price_cents < 0) p.push("price_cents 必须是 ≥0 的数字（0 = 免费）");

  const perception = raw.perception;
  if (!Array.isArray(perception) || perception.length === 0) {
    p.push("perception 必须是非空数组，首期只支持 [\"segmentation\"]");
  } else {
    for (const k of perception) {
      if (!PERCEPTIONS.includes(k as string)) p.push(`perception 里的 "${k}" 不认识`);
      if (k !== "segmentation") p.push(`perception "${k}" 引擎还没实现（见 docs/TEMPLATES.md 第三层）`);
    }
  }

  /* --- emitter --- */
  const e = raw.emitter as Raw | undefined;
  if (!e) {
    p.push("emitter 必填");
  } else {
    if (!e.asset && !e.shape) p.push("emitter 要么给 asset（一张图的 URL），要么给 shape（内置程序化道具）");
    if (e.shape && !SHAPES.includes(e.shape as string)) {
      p.push(`emitter.shape "${e.shape}" 不是内置道具，可选：${SHAPES.join(" / ")}。新外观建议走 asset，不用改代码`);
    }
    if (!num(e.aspect) || (e.aspect as number) <= 0) p.push("emitter.aspect 必须是正数（高 / 宽）");
    const port = e.port as Raw | undefined;
    if (!port || !num(port.x) || !num(port.y)) p.push("emitter.port 需要 {x, y}，单位是道具自身的宽 / 高");
    if (!num(e.band) || (e.band as number) < 0) p.push("emitter.band 必须是 ≥0 的数字");
    if (e.tilt !== undefined && !num(e.tilt)) p.push("emitter.tilt 是弧度数字");
    if (typeof e.draggable !== "boolean") p.push("emitter.draggable 必填 true/false");
    const def = e.default as Raw | undefined;
    if (!def || !num(def.x) || !num(def.y)) p.push("emitter.default 需要 {x, y}，归一化屏幕坐标");
  }

  /* --- substance --- */
  const s = raw.substance as Raw | undefined;
  if (!s) {
    p.push("substance 必填");
  } else {
    if (!num(s.gravity)) p.push("substance.gravity 必须是数字（负值向下）");
    else if ((s.gravity as number) > 0) p.push("substance.gravity 是正数，粒子会往上飘 —— 确定不是漏了负号？");
    if (!num(s.friction) || (s.friction as number) < 0 || (s.friction as number) > 1) {
      p.push("substance.friction 必须在 0~1 之间");
    }
    if (!num(s.streak) || (s.streak as number) < 0) p.push("substance.streak 必须是 ≥0 的数字（0 = 圆点，>0 = 拉伸的液体）");
    if (!triple(s.color)) p.push("substance.color 必须是三个 0~1 的数字 [r, g, b]");
    if (!pair(s.size)) p.push("substance.size 必须是 [最小, 最大]");
    if (!pair(s.speed)) p.push("substance.speed 必须是 [最小, 最大]");
    if (!num(s.spread) || (s.spread as number) < 0) p.push("substance.spread 必须是 ≥0 的弧度");
    if (!num(s.splash) || (s.splash as number) < 0) p.push("substance.splash 必须是 ≥0 的整数");
    if (typeof s.settle !== "boolean") p.push("substance.settle 必填 true/false");
    if (typeof s.twinkle !== "boolean") p.push("substance.twinkle 必填 true/false");
  }

  /* --- controls --- */
  const cs = raw.controls;
  if (!Array.isArray(cs) || cs.length === 0) {
    p.push("controls 必须是非空数组，每个模板暴露 2~4 个滑块");
  } else {
    if (cs.length > 4) p.push(`controls 有 ${cs.length} 个，PRD 建议 2~4 个 —— 再多用户就不会调了`);
    const seen = new Set<string>();
    for (const [i, c0] of cs.entries()) {
      const c = c0 as Raw;
      const at = `controls[${i}]`;
      if (typeof c.key !== "string" || !c.key) {
        p.push(`${at}.key 必填`);
        continue;
      }
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
      if (c.mode !== undefined && !MODES.includes(c.mode as string)) {
        p.push(`${at}.mode 只能是 absolute 或 scale`);
      }
      const target = c.target as string | undefined;
      if (target !== undefined) {
        const builtin = ["rate", "wind", "stick"].includes(target);
        const sub = target.startsWith("substance.") && KNOBS.includes(target.slice(10));
        if (!builtin && !sub) {
          p.push(`${at}.target "${target}" 无效。可选 rate / wind / stick，或 substance.<${KNOBS.join("|")}>`);
        }
      } else if (!["rate", "wind", "stick"].includes(c.key)) {
        p.push(`${at} 的 key "${c.key}" 不是内置语义，必须显式声明 target，否则这个滑块拖了没反应`);
      }
    }
  }

  return p;
}

/**
 * 校验通过后再跑一次解算，把「声明了但什么也不控制」的滑块揪出来。
 * 这类错误最阴——界面上滑块好好地在那儿，拖动毫无反应。
 */
export function checkWiring(cfg: TemplateConfig): string[] {
  const values = Object.fromEntries(cfg.controls.map((c: Control) => [c.key, c.default]));
  const { orphans } = resolveControls(cfg.substance, cfg.controls, values);
  return orphans.map((k) => `滑块 "${k}" 没有绑定任何参数，拖动不会有反应`);
}
