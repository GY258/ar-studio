/**
 * 轨迹缓冲：只追加的历史。
 *
 * 这是这个引擎里第一处**跨帧状态**。在它之前，renderAt(t) 是无历史的纯函数，
 * 而那正是 golden 回归、CI 不用摄像头、LLM 能拿到反馈的地基。
 * 所以加状态的方式必须让「同一份输入渲染多少次都是同一张图」继续成立。
 *
 * 做法是两条纪律：
 *
 * 1. **采样落在固定时间网格上，不是每帧一次。**
 *    每帧采一次的话，60fps 和 20fps 会生成点数完全不同的轨迹 ——
 *    离线跑出来的 golden 和线上不一致，而且换台机器就变。
 *    改成「t 跨过网格线才采」之后，任何 ≥ RATE 的帧率都采到同一批点。
 *
 * 2. **只追加，写进去不再改。** 每个点存下来就只会随时间淡出、被挤出缓冲，
 *    不参与任何交互。这是状态的最简形态：给定同一串输入，回放必然逐位相同。
 *    泡泡那种「会撞、会破、可变」的状态是另一个量级，别混进来。
 */

/**
 * 采样频率，Hz。
 *
 * 取 12 而不是 30：网格越密，低帧率下越容易跳过格子，跳过就意味着
 * 「同一段手势在慢机器上少几个点」。12Hz 下即使掉到 15fps 也不会漏格，
 * 而 12 个点/秒对一条茎来说已经足够顺 —— 它是用折线连出来的，不是散点。
 */
export const TRAIL_RATE = 12;

/**
 * 相邻两个采样点之间允许的最大位移，占画面对角线的比例。超了就断开重新起一条。
 *
 * 不设这个的话，任何「瞬移」都会被连成一条横跨画面的假线段：
 * 手划出画面再从另一边进来、检测短暂丢失后重新锁定、多只手的 handedness 互换 ——
 * 这些在真机上都会发生，而且频率不低。
 *
 * 0.18 的取法：一只手快速挥动大约 1.5 屏/秒，采样间隔 1/12 秒 → 单步约 0.12 屏。
 * 留一点余量，同时远小于「从画面一端跳到另一端」（≥0.5）。
 */
const MAX_JUMP = 0.18;

export interface TrailPoint {
  /** 归一化屏幕坐标，(0,0) 在左上，y 向下。和 landmark 同一套 */
  x: number;
  y: number;
  /** 采样时刻，秒 */
  t: number;
}

export class TrailBuffer {
  private readonly pts: TrailPoint[] = [];
  /** 上一次采样落在哪个网格格子。-1 = 还没采过 */
  private lastSlot = -1;

  constructor(
    /** 保留多久的历史，秒 */
    private readonly seconds: number,
  ) {}

  /**
   * 喂一个位置。只有 t 跨过网格线时才真的追加。
   *
   * 返回是否追加了 —— 调用方不需要，但测试靠它验「同一段时间轴采到同样多的点」。
   */
  sample(t: number, x: number, y: number): boolean {
    const slot = Math.floor(t * TRAIL_RATE);
    if (slot === this.lastSlot) return false;
    /*
     * 时间倒流时整条清掉。
     *
     * 离线 harness 会反复跳到不同的 t（先 t=0 再 t=P/4 再 t=P），
     * 不清的话第二次跳过去时缓冲里还留着上一次的点，两次渲染同一个 t 得到不同结果 ——
     * golden 当场不成立。这也是 stepTo 必须存在的原因：有状态之后不能随便跳。
     */
    if (slot < this.lastSlot) this.clear();

    // 瞬移就断开。连起来的话画面上会出现一条谁都解释不了的斜线
    const prev = this.pts[this.pts.length - 1];
    if (prev && Math.hypot(x - prev.x, y - prev.y) > MAX_JUMP) this.pts.length = 0;

    this.lastSlot = slot;
    this.pts.push({ x, y, t });
    // 按时间窗口裁剪，不按数量：数量上限会让 seconds 的语义随帧率漂
    const cutoff = t - this.seconds;
    let drop = 0;
    while (drop < this.pts.length && this.pts[drop].t < cutoff) drop++;
    if (drop) this.pts.splice(0, drop);
    return true;
  }

  /** 当前窗口内的点，从旧到新。 */
  points(): readonly TrailPoint[] {
    return this.pts;
  }

  clear() {
    this.pts.length = 0;
    this.lastSlot = -1;
  }
}
