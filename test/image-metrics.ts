/**
 * 图像对比指标。全部在 node 端自算，只依赖 pixelmatch + pngjs。
 *
 * ΔE00 十几行就能写完，为此引一个 color 库不划算——依赖越少，
 * 「断网能跑」这条越站得住。
 */

import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function decode(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

/**
 * 整帧差异像素比例。
 * threshold 0.1 是为了滤掉 SVG 栅格化的抗锯齿抖动——同一份 SVG 在不同
 * 机器上边缘像素会差一两级，逐像素严格比会永远红。
 */
export function diffRatio(a: PNG, b: PNG, threshold = 0.1): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const out = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold });
  return n / (a.width * a.height);
}

/** 差异图，断言失败时写盘给人看。 */
export function diffImage(a: PNG, b: PNG, threshold = 0.1): Buffer {
  const out = new PNG({ width: a.width, height: a.height });
  pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold, includeAA: false });
  return PNG.sync.write(out);
}

/**
 * 「元素掩膜」：渲染帧与 golden 逐像素不同的地方，就是元素画上去的地方。
 * 背景是同一张 fixture 图，所以差异区域 ≈ 元素覆盖区域。
 */
function maskOf(frame: PNG, base: PNG, tol = 12): boolean[] {
  const m = new Array<boolean>(frame.width * frame.height);
  for (let i = 0; i < m.length; i++) {
    const o = i << 2;
    m[i] =
      Math.abs(frame.data[o] - base.data[o]) +
      Math.abs(frame.data[o + 1] - base.data[o + 1]) +
      Math.abs(frame.data[o + 2] - base.data[o + 2]) >
      tol;
  }
  return m;
}

/** 两帧各自相对同一张底图的元素掩膜 IoU。 */
export function maskIoU(a: PNG, b: PNG, base: PNG, tol = 12): number {
  const ma = maskOf(a, base, tol);
  const mb = maskOf(b, base, tol);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < ma.length; i++) {
    if (ma[i] && mb[i]) inter++;
    if (ma[i] || mb[i]) union++;
  }
  return union === 0 ? 1 : inter / union;
}

/** 元素掩膜的包围盒中心，归一化到画面宽度。 */
export function maskCentroid(frame: PNG, base: PNG, tol = 12): { x: number; y: number } | null {
  const m = maskOf(frame, base, tol);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    const x = i % frame.width;
    const y = (i / frame.width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return null;
  return { x: (minX + maxX) / 2 / frame.width, y: (minY + maxY) / 2 / frame.width };
}

/** 元素掩膜覆盖的像素比例。用来卡「渲染非空」。 */
export function coverage(frame: PNG, base: PNG, tol = 12): number {
  const m = maskOf(frame, base, tol);
  return m.filter(Boolean).length / m.length;
}

/** 指定点周围 5x5 的均值色。 */
export function meanColor(p: PNG, cx: number, cy: number, r = 2): Rgb {
  let n = 0;
  let R = 0;
  let G = 0;
  let B = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= p.width || y >= p.height) continue;
      const o = (y * p.width + x) << 2;
      R += p.data[o];
      G += p.data[o + 1];
      B += p.data[o + 2];
      n++;
    }
  }
  return n ? { r: R / n, g: G / n, b: B / n } : { r: 0, g: 0, b: 0 };
}

/** 局部方差（灰度）。马赛克把细节抹平，方差会显著下降。 */
export function localVariance(p: PNG, x0: number, y0: number, w: number, h: number): number {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= p.width || y >= p.height) continue;
      const o = (y * p.width + x) << 2;
      const g = 0.299 * p.data[o] + 0.587 * p.data[o + 1] + 0.114 * p.data[o + 2];
      sum += g;
      sumSq += g * g;
      n++;
    }
  }
  if (!n) return 0;
  return sumSq / n - (sum / n) ** 2;
}

/* ---------------- ΔE00 ---------------- */

function srgbToLab({ r, g, b }: Rgb): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  // sRGB D65 → XYZ
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 色差。8 以内肉眼基本看不出差别。 */
export function deltaE00(c1: Rgb, c2: Rgb): number {
  const [L1, a1, b1] = srgbToLab(c1);
  const [L2, a2, b2] = srgbToLab(c2);
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hp = (b: number, a: number) => {
    if (b === 0 && a === 0) return 0;
    const h = Math.atan2(b, a) * deg;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hp(b1, ap1);
  const hp2 = hp(b2, ap2);

  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);

  const Lb = (L1 + L2) / 2;
  const Cpb = (Cp1 + Cp2) / 2;
  let Hb = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) Hb += hp1 + hp2 < 360 ? 360 : -360;
    Hb /= 2;
  }

  const T =
    1 -
    0.17 * Math.cos((Hb - 30) * rad) +
    0.24 * Math.cos(2 * Hb * rad) +
    0.32 * Math.cos((3 * Hb + 6) * rad) -
    0.2 * Math.cos((4 * Hb - 63) * rad);
  const dTheta = 30 * Math.exp(-(((Hb - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb;
  const Sh = 1 + 0.015 * Cpb * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;

  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/**
 * 「亮而不饱和」的像素占比。
 *
 * lowres-life 的菜单是浅灰白面板，背景是彩色画面，用这个能把面板本身量出来。
 * 不能用 coverage 量它——那个模板有全屏马赛克，相对空模板底图的差异区域是整幅画面，
 * 覆盖率恒等于 1，缩放前后都一样，断言等于没写。
 */
export function panelArea(p: PNG, minBright = 195, maxChroma = 28): number {
  let n = 0;
  for (let i = 0; i < p.width * p.height; i++) {
    const o = i << 2;
    const r = p.data[o];
    const g = p.data[o + 1];
    const b = p.data[o + 2];
    const mn = Math.min(r, g, b);
    if (mn > minBright && Math.max(r, g, b) - mn < maxChroma) n++;
  }
  return n / (p.width * p.height);
}
