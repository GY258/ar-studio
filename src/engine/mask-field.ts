/**
 * 帧效果专用的人像蒙版。
 *
 * 为什么不复用 OccupancyField：那个场是给粒子碰撞用的，112×63 格、3×3 盒式模糊、
 * α=0.45 重时域平滑——粗和糊对碰撞是优点（不糊粒子会沿人体边缘抖）。
 * 但 MediaPipe 实际吐出来的 categoryMask 和输入同分辨率（实测 960×540），
 * 降到 112×63 是把格子数砍掉 74 倍，边缘只剩台阶，抠图看着就是「检测不准」。
 *
 * 这里保留接近原生的分辨率，只做轻量平滑，专门喂给帧效果的 shader。
 * 两个场各管各的，谁也不迁就谁。
 */

/** 长边上限。960×540 → 512×288，每帧 15 万次运算，亚毫秒级。 */
const MAX_DIM = 512;

/**
 * 时域平滑系数。比占据场的 0.45 高，因为这里要的是跟手，
 * 而不是让粒子沿边缘不抖——蒙版慢半拍，人一动边缘就拖影。
 */
const ALPHA = 0.6;

export class MaskField {
  /** 本帧降采样出来的 0/1 */
  private raw: Float32Array | null = null;
  /** 羽化后的本帧值 */
  private blurred: Float32Array | null = null;
  /** 跨帧累积值。和上面两个分开，否则羽化的中间结果会把它冲掉 */
  private accum: Float32Array | null = null;
  /** 上传给纹理的 R8 数据 */
  private out: Uint8Array | null = null;
  private w = 0;
  private h = 0;
  /** 羽化半径，格。由 feather × 长边算出来 */
  private blurRadius = 0;
  /** 见过人。空场景也会 ingest 成功，所以按占据比例判定而不是「调用过就算」 */
  seen = false;

  get width() {
    return this.w;
  }
  get height() {
    return this.h;
  }
  get data() {
    return this.out;
  }

  /** feather 是归一化到长边的羽化宽度。0 = 硬边。 */
  setFeather(feather: number) {
    this.blurRadius = Math.min(16, Math.max(0, Math.round(feather * MAX_DIM)));
  }

  private resize(mw: number, mh: number) {
    const scale = Math.min(1, MAX_DIM / Math.max(mw, mh));
    const w = Math.max(1, Math.round(mw * scale));
    const h = Math.max(1, Math.round(mh * scale));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.raw = new Float32Array(w * h);
    this.blurred = new Float32Array(w * h);
    this.accum = new Float32Array(w * h);
    this.out = new Uint8Array(w * h);
  }

  /**
   * 吃一帧置信度图（0~1）。
   *
   * **不做二值化。** 这是这个场和占据场最大的区别：模型给的连续值里
   * 带着头发丝、耳廓、肩线的真实过渡，切成 0/1 就只剩一圈用盒式模糊硬凑出来的
   * 均匀粗边 —— 头发糊成一顶头盔，那正是「抠得不准」最主要的观感来源。
   *
   * 原来这里还有一段四角采样定背景值的逻辑，那是 categoryMask 时代的产物
   * （不同版本里「人」编码成 0 还是非 0 不一致）。置信度的语义是固定的，
   * 1 = 人，不需要猜，顺带也就不怕「贴着墙拍、四角也是人」把假设打破。
   */
  ingest(raw: Float32Array, mw: number, mh: number) {
    if (mw <= 0 || mh <= 0) return;
    this.resize(mw, mh);
    const { w, h, raw: cur, blurred, accum, out } = this;
    if (!cur || !blurred || !accum || !out) return;

    // 最近邻降采样，值原样保留（下一步会换成面积平均）
    let occupied = 0;
    for (let y = 0; y < h; y++) {
      const sy = ((y * mh) / h) | 0;
      for (let x = 0; x < w; x++) {
        const v = raw[sy * mw + (((x * mw) / w) | 0)];
        cur[y * w + x] = v;
        // 「见过人」按半数以上把握算，不把过渡带的半信半疑计进去
        if (v > 0.5) occupied++;
      }
    }
    this.seen = occupied > w * h * 0.005;

    if (this.blurRadius > 0) boxBlur(cur, blurred, w, h, this.blurRadius);
    const src = this.blurRadius > 0 ? blurred : cur;

    for (let i = 0; i < out.length; i++) {
      accum[i] += (src[i] - accum[i]) * ALPHA;
      out[i] = (accum[i] * 255) | 0;
    }
  }

  /** 人不见了：把蒙版整体设成某个常量（onLost 兜底用）。 */
  fill(value: number) {
    if (!this.out || !this.accum) return;
    this.out.fill(value);
    this.accum.fill(value / 255);
  }

  reset() {
    this.accum?.fill(0);
    this.seen = false;
  }
}

/** 可分离盒式模糊，两趟。羽化半径大的时候比 3×3 便宜得多。 */
function boxBlur(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const inv = 1 / (r * 2 + 1);
  const row = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const o = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      row[o + x] = sum * inv;
      sum -= src[o + Math.min(w - 1, Math.max(0, x - r))];
      sum += src[o + Math.min(w - 1, Math.max(0, x + r + 1))];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += row[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * inv;
      sum -= row[Math.min(h - 1, Math.max(0, y - r)) * w + x];
      sum += row[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
    }
  }
}
