/**
 * PNG → Y4M，给 chromium 的假摄像头用。
 *
 * 为什么是 Y4M 而不是 MJPEG：Y4M 是未压缩的 YUV，用 pngjs 就能写出来，
 * **零额外依赖、跨平台**。MJPEG 要一个 JPEG 编码器；我最早是 shell 出去调 macOS 的 sips，
 * 那个在 Linux CI 和别人的机器上直接不存在 —— 一个「只在作者机器上能跑的验证脚本」
 * 和没有验证脚本差别不大。
 *
 * chromium 会把这个文件循环播放，所以几帧就够。
 */

import fs from "node:fs";
import { PNG } from "pngjs";

/** BT.601 全范围。假摄像头是喂给检测模型的，不追求色彩精确 */
const rgbToY = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const rgbToU = (r: number, g: number, b: number) => -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
const rgbToV = (r: number, g: number, b: number) => 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * 把一张 PNG 写成 Y4M。
 *
 * 宽高必须是偶数：4:2:0 的色度平面按 2×2 块下采样，奇数尺寸最后一行/列算不出来。
 * fixture 是 960×540 本来就是偶数，这里断言掉是防以后换图踩坑。
 */
export interface Y4mOptions {
  frames?: number;
  fps?: number;
  /**
   * 整帧纵向平移的总量，占画面高度的比例。正数 = 画面内容往下走。
   *
   * 走的是**往返**（下去再回来），不是单程。chromium 是循环播放这个文件的，
   * 单程的话循环回第一帧等于画面瞬移，轨迹上会连出一条横跨画面的假线段 ——
   * 第一次加平移时就是这么翻的车。往返让首尾两帧位置相同，循环无缝。
   *
   * 有它才能验**依赖运动的功能**。轨迹（茎）画的是「锚点走过的路」，
   * 静态输入下指尖永远不动、一条带都画不出来 —— 冒烟跑过了却什么都没验到，
   * 这种「绿着的盲区」比红着更危险。
   */
  panY?: number;
}

/**
 * 把一张 PNG 写成 Y4M。
 *
 * 宽高必须是偶数：4:2:0 的色度平面按 2×2 块下采样，奇数尺寸最后一行/列算不出来。
 * fixture 是 960×540 本来就是偶数，这里断言掉是防以后换图踩坑。
 */
export function pngToY4m(pngPath: string, outPath: string, opts: Y4mOptions = {}) {
  const { frames = 4, fps = 30, panY = 0 } = opts;
  const img = PNG.sync.read(fs.readFileSync(pngPath));
  const w = img.width;
  const h = img.height;
  if (w % 2 || h % 2) {
    throw new Error(`${pngPath} 的宽高必须是偶数（4:2:0 色度按 2×2 下采样），当前 ${w}x${h}`);
  }

  /** 取源图第 (i, j) 个像素，纵向偏移 dy 行，越界就夹到边缘 */
  const at = (i: number, j: number, dy: number) => {
    const jj = Math.max(0, Math.min(h - 1, j - dy));
    return (jj * w + i) << 2;
  };

  const buildFrame = (dy: number) => {
    const y = Buffer.alloc(w * h);
    const u = Buffer.alloc((w / 2) * (h / 2));
    const v = Buffer.alloc((w / 2) * (h / 2));
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const o = at(i, j, dy);
        y[j * w + i] = clamp8(rgbToY(img.data[o], img.data[o + 1], img.data[o + 2]));
      }
    }
    // 色度取 2×2 平均而不是左上角一个点：取一个点会让细纹理区域出现明显偏色
    for (let j = 0; j < h; j += 2) {
      for (let i = 0; i < w; i += 2) {
        let su = 0;
        let sv = 0;
        for (const [dj, di] of [
          [0, 0],
          [0, 1],
          [1, 0],
          [1, 1],
        ] as const) {
          const o = at(i + di, j + dj, dy);
          su += rgbToU(img.data[o], img.data[o + 1], img.data[o + 2]);
          sv += rgbToV(img.data[o], img.data[o + 1], img.data[o + 2]);
        }
        const ci = (j / 2) * (w / 2) + i / 2;
        u[ci] = clamp8(su / 4);
        v[ci] = clamp8(sv / 4);
      }
    }
    return [y, u, v];
  };

  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`)];
  for (let f = 0; f < frames; f++) {
    // 往返：前半程往下，后半程回来。首尾同位，循环时不会瞬移
    const p = frames > 1 ? f / (frames - 1) : 0;
    const tri = p <= 0.5 ? p * 2 : (1 - p) * 2;
    const dy = Math.round(panY * h * tri);
    const [y, u, v] = buildFrame(dy);
    parts.push(Buffer.from("FRAME\n"), y, u, v);
  }
  fs.writeFileSync(outPath, Buffer.concat(parts));
  return { w, h, frames, bytes: parts.reduce((n, p) => n + p.length, 0) };
}
