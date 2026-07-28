/**
 * 动画原语。overlay 与 facetrack 共用一套，参数化不写死。
 */

export type AnimationV2 =
  | { preset: "float";  amplitude: number; period: number; phase?: number }
  | { preset: "fall";   period: number; phase?: number }
  | { preset: "pulse";  scaleRange: [number, number]; period: number; phase?: number }
  | { preset: "spin";   period: number; phase?: number }
  | { preset: "emit-fall-fade";
      distance: number;
      period: number;
      phase?: number;
      outwardDrift?: number;
      shrink?: number;
      emitPortion?: number;
      fadePortion?: number };

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
        state.positionYAbsolute = topY + (botY - topY) * progress;
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
          const p = (progress - emitP) / (1 - emitP - fadeP);
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
