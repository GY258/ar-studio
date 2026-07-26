import type { Control, ControlTarget, ControlValues, Substance, SubstanceKnob } from "./types";

/**
 * 把「模板基准参数 + 用户拨到的滑块位置」解算成这一帧真正要用的参数。
 *
 * 存在的意义是让引擎不认识任何具体滑块。引擎只问这个函数要 substance 和三个内置旋钮，
 * 于是新模板可以在 JSON 里声明任意滑块（比如「颗粒大小」绑到 substance.size），
 * 一行引擎代码都不用改。
 */

/** 引擎内置的三个旋钮，不属于物质本身。 */
export interface Knobs {
  /** 每秒发射多少个粒子。 */
  rate: number;
  /** 横向风的目标速度，px/s。 */
  wind: number;
  /** 黏附倍率，乘到 substance.friction 上。 */
  stick: number;
}

const DEFAULT_KNOBS: Knobs = { rate: 800, wind: 0, stick: 1 };

/** 滑块 0~100 → 摩擦倍率 0.4~2.0。0 打滑，100 糊住。 */
function stickCurve(v: number): number {
  return 0.4 + (v / 100) * 1.6;
}

function targetOf(c: Control): ControlTarget | null {
  if (c.target) return c.target;
  if (c.key === "rate" || c.key === "wind" || c.key === "stick") return c.key;
  return null; // 既没声明 target、key 又不是内置语义 —— 这个滑块什么也不控制
}

export interface Resolved {
  substance: Substance;
  knobs: Knobs;
  /** 声明了但没绑到任何东西的滑块 key，交给校验器报出来。 */
  orphans: string[];
}

export function resolveControls(
  base: Substance,
  controls: Control[],
  values: ControlValues,
  degraded = false,
): Resolved {
  // 浅拷贝 + tuple 单独拷，别改到模板的基准值上
  const substance: Substance = { ...base, size: [...base.size], speed: [...base.speed], color: [...base.color] };
  const knobs: Knobs = { ...DEFAULT_KNOBS };
  const orphans: string[] = [];

  for (const c of controls) {
    const target = targetOf(c);
    if (!target) {
      orphans.push(c.key);
      continue;
    }
    const raw = values[c.key] ?? c.default;

    if (target === "rate" || target === "wind") {
      knobs[target] = raw;
      continue;
    }
    if (target === "stick") {
      knobs.stick = stickCurve(raw);
      continue;
    }

    const field = target.slice("substance.".length) as SubstanceKnob;
    const mode = c.mode ?? "scale";
    const k = raw / 100;

    // 分开写而不是统一索引：tuple 字段和数值字段的写入类型不同，
    // 合在一起 TS 会把两者交起来变成 never。
    if (field === "size" || field === "speed") {
      const cur = substance[field];
      substance[field] = mode === "scale" ? [cur[0] * k, cur[1] * k] : [raw, raw];
    } else {
      const cur = substance[field];
      substance[field] = mode === "scale" ? cur * k : raw;
    }
  }

  // 移动端降级：粒子减半、关溅射（PRD 5.2）
  if (degraded) {
    knobs.rate *= 0.5;
    substance.splash = 0;
  }

  return { substance, knobs, orphans };
}
