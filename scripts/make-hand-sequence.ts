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
/**
 * 捏合发生在序列的这几段（占全程比例）。两段是为了验边沿触发而不是状态触发。
 *
 * **必须和 CURL_WINDOW 错开。** 手指弯起来的时候拇指尖和食指尖天然就靠近了，
 * 捏合判定看的正是「两指距离 / 掌宽」—— 两件事重叠的话弯手指会误触发捏合，
 * 捏合的边沿测试就变成在测弯曲了。
 */
const PINCH_WINDOWS: [number, number][] = [
  [0.12, 0.2],
  [0.8, 0.88],
];

/**
 * 手指弯曲扫动的窗口。窗口内 0 → 1 → 0 走一趟（正弦），窗口外保持伸直。
 *
 * 为什么必须有：茎的长度**完全**由弯曲度决定，而 fixture 那张照片是伸开的手
 * （用引擎自己的公式量出来是 0.00~0.01）。不合成弯曲的话，
 * 离线和冒烟都会「全绿但一根茎都没画出来」—— 这种绿着的盲区比红着更危险。
 *
 * 落在两段捏合中间，见 PINCH_WINDOWS 的注释。
 */
const CURL_WINDOW: [number, number] = [0.32, 0.72];
/** 每根手指的弯曲错开多少（占全程比例）。错开才能验「每根茎只吃自己那根手指」 */
const CURL_STAGGER = 0.015;

/** 每根手指的关节链和「完全握起」的弦长/展开长比值。必须和 hand-tracker.ts 里一致 */
const FINGER_CHAINS: { name: string; joints: number[]; full: number }[] = [
  { name: "thumb", joints: [2, 3, 4], full: 0.72 },
  { name: "index", joints: [5, 6, 7, 8], full: 0.5 },
  { name: "middle", joints: [9, 10, 11, 12], full: 0.5 },
  { name: "ring", joints: [13, 14, 15, 16], full: 0.5 },
  { name: "pinky", joints: [17, 18, 19, 20], full: 0.5 },
];

/** 绕 (ox, oy) 转 a 弧度 */
function rot(q: Pt, ox: number, oy: number, a: number): Pt {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = q.x - ox;
  const dy = q.y - oy;
  return { x: ox + dx * c - dy * s, y: oy + dx * s + dy * c, z: q.z };
}

/**
 * 正向运动学地弯一根手指：从指根开始，每一节连着它后面所有的点一起转 a。
 *
 * 方向取「让指尖离手腕更近」的那一边 —— 我的弯曲度公式对旋转方向不敏感
 * （弦长跟符号无关），但反着弯出来的手看着像断了，fixture 还是要像真的。
 */
function bendFinger(pts: Pt[], joints: number[], a: number, wrist: Pt) {
  const tryBend = (sign: number) => {
    const out = pts.map((q) => ({ ...q }));
    for (let k = 0; k < joints.length - 1; k++) {
      const o = out[joints[k]];
      for (let m = k + 1; m < joints.length; m++) out[joints[m]] = rot(out[joints[m]], o.x, o.y, sign * a);
    }
    return out;
  };
  const plus = tryBend(1);
  const minus = tryBend(-1);
  const tip = joints[joints.length - 1];
  const d = (arr: Pt[]) => Math.hypot(arr[tip].x - wrist.x, arr[tip].y - wrist.y);
  return d(plus) <= d(minus) ? plus : minus;
}

/** 一根手指当前的弦长/展开长比值 */
function ratioOf(pts: Pt[], joints: number[]) {
  let ext = 0;
  for (let k = 1; k < joints.length; k++) {
    ext += Math.hypot(pts[joints[k]].x - pts[joints[k - 1]].x, pts[joints[k]].y - pts[joints[k - 1]].y);
  }
  if (ext < 1e-9) return 1;
  const a = pts[joints[0]];
  const b = pts[joints[joints.length - 1]];
  return Math.hypot(b.x - a.x, b.y - a.y) / ext;
}

/**
 * 弯到「引擎量出来正好是 target」为止，二分找角度。
 *
 * 不直接写死一个角度，是因为那样得靠猜 —— 而这里可以直接用引擎的同一个公式
 * 反解。这样 fixture 就**保证**真的扫过 0→1 整个区间，而不是「大概弯了不少」。
 */
function bendToCurl(pts: Pt[], chain: { joints: number[]; full: number }, target: number, wrist: Pt): Pt[] {
  if (target <= 1e-3) return pts;
  const wantRatio = 1 - target * (1 - chain.full);
  let lo = 0;
  let hi = 2.6;
  let best = pts;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const cand = bendFinger(pts, chain.joints, mid, wrist);
    const r = ratioOf(cand, chain.joints);
    best = cand;
    if (r > wantRatio) lo = mid;
    else hi = mid;
  }
  return best;
}

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
        let pts: Pt[] = h.points.map((q) => ({
          x: q.x + dx,
          y: q.y + dy,
          z: q.z,
        }));

        // 弯手指。每根错开一点，这样同一帧里五根的弯曲度都不同
        const wrist = pts[0];
        for (let fi = 0; fi < FINGER_CHAINS.length; fi++) {
          const [w0, w1] = CURL_WINDOW;
          const u = (p - w0 - fi * CURL_STAGGER) / (w1 - w0);
          const target = u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u);
          pts = bendToCurl(pts, FINGER_CHAINS[fi], target, wrist);
        }
        pts = pts.map((q) => ({ x: +q.x.toFixed(4), y: +q.y.toFixed(4), z: q.z }));
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
    `运动是合成的（下落 ${DROP} + 横向飘 ${SWAY} + ${PINCH_WINDOWS.length} 段捏合 + ` +
      `弯曲扫动 ${CURL_WINDOW[0]}~${CURL_WINDOW[1]}），几何是真模型录的。理由见脚本头部注释。`,
  );

  // 把实际扫到的弯曲区间打出来。合成完不验一遍的话，「弯了但没弯够」
  // 会表现成「茎只长了一小截」，而那看起来跟参数没调好一模一样
  const span: Record<string, [number, number]> = {};
  for (const ch of FINGER_CHAINS) {
    let lo = 1;
    let hi = 0;
    for (const fr of frames) {
      const r = ratioOf(fr[0].points, ch.joints);
      const c = Math.max(0, Math.min(1, (1 - r) / (1 - ch.full)));
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
    }
    span[ch.name] = [+lo.toFixed(2), +hi.toFixed(2)];
  }
  console.log("实际弯曲区间:", JSON.stringify(span));
}

main();
