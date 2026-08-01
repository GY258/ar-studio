/**
 * 哪些 asset 参数能被滑块实时改。
 *
 * 单独一个文件，理由和 source-effects.ts 一样：校验器要拿到这张表，
 * 而它跑在服务端和 CI 脚本里，不该为了一张常量表把 three 和 MediaPipe 拖进去。
 *
 * **这是唯一的事实来源。** 引擎按它分发，校验器按它拦截 ——
 * 两边各写各的名单正是这个仓库反复出问题的地方（blur 曾经能过校验、
 * 能渲染、什么都不做也不报错，就是因为两份名单不一致）。
 *
 * 没列进来的参数不是不能调，是**改了要重建 mesh**（比如 boxes 决定实例缓冲的
 * 容量、digits 决定字形实例数）。那种参数走模板 JSON，不该挂在滑块上 ——
 * 拖一下滑块就重建一次几何，手感和开销都不对。
 */
export const TUNABLE_PARAMS: Record<string, readonly string[]> = {
  fluidity: ["detectHz", "idleRate", "density", "jitter", "boxSize", "boxSizeSpread", "labelRatio", "digitSize", "lineReach", "fillRatio", "opacity"],
  bubbles: ["rise", "wobble", "popRadius", "refraction", "iridescence", "opacity"],
};

/** `element.<元素 id>.<参数名>` 这种 target 的解析结果 */
export interface ElementTarget {
  elementId: string;
  param: string;
}

/** 解析元素滑块的 target。不是这个形态返回 null，让调用方回落到内置旋钮 */
export function parseElementTarget(target: string): ElementTarget | null {
  const m = /^element\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)$/.exec(target);
  return m ? { elementId: m[1], param: m[2] } : null;
}
