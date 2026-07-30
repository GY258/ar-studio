#!/usr/bin/env tsx
/**
 * 把单帧手部 fixture 扩成一段「手往下移」的序列。
 *
 * 为什么需要序列：轨迹类模板（茎）画的是「锚点走过的路」，
 * 一帧静态数据只有一个点，画不出带 —— 离线连「能不能画出来」都验不了。
 *
 * 为什么是合成运动而不是真录一段：手上那张 fixture 是**照片**不是视频。
 * 几何是真的（21 点是真模型在真照片上跑出来的），只有位移是合成的。
 * 这对验证轨迹机制完全够用 —— 要验的是「采样、成带、长叶子」这套逻辑，
 * 而不是「MediaPipe 在连续帧上抖不抖」。
 *
 * 真要验后者得录一段视频再逐帧跑模型，那是另一笔活；
 * 到时候直接覆盖同名文件即可，下游一行都不用改。
 *
 * 用法：npx tsx scripts/make-hand-sequence.ts
 */

import fs from "node:fs";
import path from "node:path";

const FIXTURES = path.join(process.cwd(), "test/fixtures");
const FILE = path.join(FIXTURES, "hands.hands.json");

/** 序列帧率。和 TRAIL_RATE(12) 拉开距离，好验「采样落在时间网格上」而不是「每帧一采」 */
const FPS = 30;
/** 多长。3 秒够画出一条完整的茎，也够看到叶子沿途长出来 */
const SECONDS = 3;
/** 手往下移多少（归一化画面高度）。0.42 让指尖从上半部走到接近底部 */
const DROP = 0.55;
/**
 * 横向轻微飘动的幅度。完全直下的轨迹是一根直线，看不出带的宽度和法向算得对不对；
 * 但幅度大了茎会卷成钩子，看不出「茎」这个意思。0.014 是两者之间。
 */
const SWAY = 0.014;
/** 捏合发生在序列的这几段（占全程比例）。两段是为了验边沿触发而不是状态触发 */
const PINCH_WINDOWS: [number, number][] = [
  [0.3, 0.4],
  [0.66, 0.74],
];

type Pt = { x: number; y: number; z: number };
type Hand = { hand: "left" | "right"; points: Pt[] };

function main() {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as Hand[] | { fps: number; frames: Hand[][] };
  const base = Array.isArray(raw) ? raw : raw.frames[0];
  if (!base?.length) throw new Error(`${FILE} 里没有手部数据，先跑 npm run record:fixture -- hands`);

  const total = FPS * SECONDS;
  const frames: Hand[][] = [];
  for (let f = 0; f < total; f++) {
    const p = f / (total - 1);
    // 略微缓入的下落。用 p² 的话前半段几乎不动，三秒里只走出一小段，
    // 茎短到看不出是茎 —— 指数取 1.25 既保留「起步稍慢」的手感，又让全程都在走
    const dy = DROP * Math.pow(p, 1.25);
    const dx = Math.sin(p * Math.PI * 2.2) * SWAY;
    /*
     * 捏合：把拇指尖和食指尖往中点收。
     *
     * 只动指尖那两个点，不动整只手 —— 判定用的是「两指距离 / 掌宽」，
     * 掌宽得保持不变才能验出比值真的降下去了。
     * 两段捏合是为了验**边沿**触发：状态触发的话第一段里每帧都会冒一朵。
     */
    const inPinch = PINCH_WINDOWS.some(([a, b]) => p >= a && p <= b);
    frames.push(
      base.map((h) => {
        const pts = h.points.map((q) => ({
          x: +(q.x + dx).toFixed(4),
          y: +(q.y + dy).toFixed(4),
          z: q.z,
        }));
        if (inPinch) {
          const [ti, ii] = [4, 8]; // thumb_tip / index_tip
          const cx = (pts[ti].x + pts[ii].x) / 2;
          const cy = (pts[ti].y + pts[ii].y) / 2;
          for (const i of [ti, ii]) {
            pts[i] = { x: +(cx + (pts[i].x - cx) * 0.12).toFixed(4), y: +(cy + (pts[i].y - cy) * 0.12).toFixed(4), z: pts[i].z };
          }
        }
        return { hand: h.hand, points: pts };
      }),
    );
  }

  fs.writeFileSync(FILE, JSON.stringify({ fps: FPS, frames }));
  const kb = (fs.statSync(FILE).size / 1024) | 0;
  console.log(`${path.relative(process.cwd(), FILE)}  ${total} 帧 @ ${FPS}fps（${SECONDS}s），${kb}KB`);
  console.log(
    `运动是合成的（下落 ${DROP} + 横向飘 ${SWAY} + ${PINCH_WINDOWS.length} 段捏合），` +
      `几何是真模型录的。理由见脚本头部注释。`,
  );
}

main();
