/**
 * 占据场：人像遮罩 → 低分辨率标量场，粒子靠它做碰撞。
 *
 * 两条不做就会翻车的（PRD 5.2）：
 *  - 时间平滑。单帧分割会闪，直接用会让粒子抽搐。
 *  - 先模糊再求梯度。硬边的 0/1 求出来的法线逐格跳变，粒子沿人体边缘会抖。
 */

export const GW = 112;
export const GH = 63;

export class OccupancyField {
  readonly grid = new Float32Array(GW * GH); // 时间平滑后的占据度 0~1
  private readonly raw = new Float32Array(GW * GH);
  private readonly tmp = new Float32Array(GW * GH);
  seen = false;

  /** 世界坐标尺寸，由渲染器每帧同步过来。 */
  private w = 1280;
  private h = 720;

  setViewport(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  /**
   * 吃一帧 MediaPipe 的 categoryMask。
   *
   * 不同模型 / 版本里「人」到底编码成 0 还是非 0 并不一致，
   * 所以用四角采样定背景值——角落几乎总是背景。
   * 例外：贴着墙拍、角落里也是人，这个假设会破，那时候把 bgVal 写死成实测值。
   */
  ingest(data: Uint8Array, mw: number, mh: number) {
    const corners = [data[0], data[mw - 1], data[(mh - 1) * mw], data[mh * mw - 1]].sort((a, b) => a - b);
    const bgVal = corners[1];

    for (let y = 0; y < GH; y++) {
      const sy = ((y * mh) / GH) | 0;
      for (let x = 0; x < GW; x++) {
        this.raw[y * GW + x] = data[sy * mw + (((x * mw) / GW) | 0)] !== bgVal ? 1 : 0;
      }
    }

    // seen 的语义是「见过人」，不是「收到过一帧 mask」。
    // 之前只要 ingest 被调用就置 true，于是空场景也算「见过人」——
    // 帧效果的 onLost 兜底直接失效（人走出画面，背景仍然糊着）。
    let occupied = 0;
    for (let i = 0; i < this.raw.length; i++) occupied += this.raw[i];
    this.seen = occupied > this.raw.length * 0.005;

    // 3x3 盒式模糊：让边缘有梯度
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || yy >= GH || xx < 0 || xx >= GW) continue;
            s += this.raw[yy * GW + xx];
            n++;
          }
        }
        this.tmp[y * GW + x] = s / n;
      }
    }

    // 时间平滑 α≈0.45
    for (let i = 0; i < this.grid.length; i++) {
      this.grid[i] += (this.tmp[i] - this.grid[i]) * 0.45;
    }
  }

  /**
   * 世界坐标采样，双线性。
   * 注意 u 的映射带了镜像（0.5 - x/W），和背景平面的 scale.x = -1 是一对。
   * 改一个就得改另一个，否则人和特效会反向。
   */
  at(wx: number, wy: number): number {
    const u = 0.5 - wx / this.w;
    const v = 0.5 - wy / this.h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const gx = u * (GW - 1);
    const gy = v * (GH - 1);
    const x0 = gx | 0;
    const y0 = gy | 0;
    const x1 = Math.min(x0 + 1, GW - 1);
    const y1 = Math.min(y0 + 1, GH - 1);
    const fx = gx - x0;
    const fy = gy - y0;
    const a = this.grid[y0 * GW + x0];
    const b = this.grid[y0 * GW + x1];
    const c = this.grid[y1 * GW + x0];
    const d = this.grid[y1 * GW + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /** 调试用预览，画到一张 112x63 的 canvas 上。 */
  debugDraw(ctx: CanvasRenderingContext2D) {
    const img = ctx.createImageData(GW, GH);
    for (let i = 0; i < GW * GH; i++) {
      const v = (this.grid[i] * 255) | 0;
      img.data[i * 4] = (v * 0.79) | 0;
      img.data[i * 4 + 1] = (v * 0.63) | 0;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
}
