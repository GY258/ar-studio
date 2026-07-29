/**
 * 动画原语。overlay 与 facetrack 共用一套，参数化不写死。
 */

/**
 * 进度曲线。默认 linear，输出与没有这个字段时逐位相同。
 *
 * 只有「0→1 走一趟」的原语（fall / emit-fall-fade）支持它。
 * float / pulse / spin 是周期性的，把 ease 套在相位上会在每个周期的
 * 接缝处留一个速度拐折 —— 转一圈然后顿一下，比匀速更假。
 * 它们要非匀速的话得换一条路（多段关键帧），不是这个字段能表达的，
 * 所以校验器直接拒收，而不是收下来悄悄不生效。
 */
export type Ease = "linear" | "in" | "out" | "inout" | "gravity" | "bounce";

export type AnimationV2 =
  | { preset: "float";  amplitude: number; period: number; phase?: number }
  | { preset: "fall";   period: number; phase?: number; ease?: Ease }
  | { preset: "pulse";  scaleRange: [number, number]; period: number; phase?: number }
  | { preset: "spin";   period: number; phase?: number }
  | { preset: "emit-fall-fade";
      distance: number;
      period: number;
      phase?: number;
      ease?: Ease;
      outwardDrift?: number;
      shrink?: number;
      emitPortion?: number;
      fadePortion?: number };

/**
 * 0..1 的线性进度 → 缓动后的进度。两端必须钉死 f(0)=0、f(1)=1，
 * 否则 L2 的「t=P 与 t0 差异≈0」周期闭合断言就不成立了。
 */
export function applyEase(p: number, ease: Ease = "linear"): number {
  switch (ease) {
    case "in":
      return p * p;
    case "out":
      return 1 - (1 - p) * (1 - p);
    case "inout":
      return p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
    // gravity 与 in 同曲线：自由落体位移是 ½gt²。语义不同所以保留两个名字，
    // 「眼泪是重力下落」比「眼泪是 ease-in」好读，将来要换成带初速的曲线也只改这一支。
    case "gravity":
      return p * p;
    case "bounce": {
      // 标准 bounce-out。四段抛物线，落地三次反弹一次比一次低。
      const n = 7.5625;
      const d = 2.75;
      if (p < 1 / d) return n * p * p;
      if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
      if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
      return n * (p -= 2.625 / d) * p + 0.984375;
    }
    default:
      return p;
  }
}

export interface AnimState {
  /** 相对锚点的 y 位移，px */
  positionY: number;
  /**
   * 绝对世界 y，px。非 null 时覆盖锚点算出来的位置。
   * fall 用它：一滴雨从画面顶飞到画面底，走的是整屏高度，跟它锚在 ny 多少无关。
   */
  positionYAbsolute: number | null;
  scaleX: number;
  scaleY: number;
  opacity: number;
  rotation: number;
  outwardX: number;
}

const DEFAULT: AnimState = {
  positionY: 0,
  positionYAbsolute: null,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  rotation: 0,
  outwardX: 0,
};

/** 计算动画在时间 t 的状态。多个动画叠加。 */
export function evaluateAnimations(
  animations: AnimationV2[] | undefined,
  t: number,
  baseH: number,
  iod: number,
): AnimState {
  if (!animations || animations.length === 0) return { ...DEFAULT };

  const state = { ...DEFAULT };

  for (const anim of animations) {
    const phase = anim.phase ?? 0;

    switch (anim.preset) {
      case "float": {
        state.positionY += Math.sin((t / anim.period + phase) * Math.PI * 2) * baseH * anim.amplitude;
        break;
      }
      case "fall": {
        const progress = ((t / anim.period + phase) % 1);
        const topY = baseH / 2 + baseH * 0.15;
        const botY = -baseH / 2 - baseH * 0.15;
        state.positionYAbsolute = topY + (botY - topY) * applyEase(progress, anim.ease);
        // 淡入淡出用**原始** progress：跟着缓动走的话头尾两段时长会不对称，
        // 一头刚冒出来就到位、另一头拖很久，读起来是「卡了一下」。
        if (progress < 0.08) state.opacity = progress / 0.08;
        else if (progress > 0.88) state.opacity = (1 - progress) / 0.12;
        else state.opacity = 0.95;
        break;
      }
      case "pulse": {
        const p = (Math.sin((t / anim.period + phase) * Math.PI * 2) + 1) / 2;
        const s = anim.scaleRange[0] + p * (anim.scaleRange[1] - anim.scaleRange[0]);
        state.scaleX *= s;
        state.scaleY *= s;
        break;
      }
      case "spin": {
        state.rotation += ((t / anim.period + phase) % 1) * Math.PI * 2;
        break;
      }
      case "emit-fall-fade": {
        const emitP = anim.emitPortion ?? 0.15;
        const fadeP = anim.fadePortion ?? 0.15;
        const progress = ((t / anim.period + phase) % 1);

        if (progress < emitP) {
          const p = progress / emitP;
          state.scaleX *= p;
          state.scaleY *= p;
          state.opacity = p;
        } else if (progress < 1 - fadeP) {
          // 缓动只作用于中段的位移/缩放。冒出段和淡出段是纯透明度渐变，
          // 给它们加速会让那两段看起来在闪。
          const p = applyEase((progress - emitP) / (1 - emitP - fadeP), anim.ease);
          const shrinkFactor = 1 - (anim.shrink ?? 0.3) * p;
          state.scaleX *= shrinkFactor;
          state.scaleY *= shrinkFactor;
          state.positionY -= p * iod * anim.distance;
          state.outwardX = p * iod * (anim.outwardDrift ?? 0.08);
        } else {
          const p = (progress - (1 - fadeP)) / fadeP;
          state.scaleX *= 1 - (anim.shrink ?? 0.3);
          state.scaleY *= 1 - (anim.shrink ?? 0.3);
          state.positionY -= iod * anim.distance;
          state.outwardX = iod * (anim.outwardDrift ?? 0.08);
          state.opacity = 1 - p;
        }
        break;
      }
    }
  }

  return state;
}
