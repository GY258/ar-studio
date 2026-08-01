#!/usr/bin/env tsx
/**
 * 把单帧姿态 fixture 扩成一段「手臂张开又收回」的序列。
 *
 * 为什么需要：Fluidity 的核心行为是「张开手臂时框和线爆发式增多、收拢时骤减」，
 * 而它由 spread（双腕间距 / 肩宽）驱动。手上两张全身 fixture **都是手垂着的**，
 * spread 恒定在 0 附近 —— 离线连「密度会不会随姿态变」都验不了，
 * 测试全绿但那条断言什么都没证明。
 *
 * 为什么是合成而不是真录：fixture 是**照片**不是视频。几何是真的
 * （33 点是真模型在真照片上跑出来的），只有手臂的开合是合成的。
 * 验的是「密度跟着 spread 走」这套逻辑，不是「模型在连续帧上抖不抖」。
 *
 * 用法：npx tsx scripts/make-pose-sequence.ts body
 */

import fs from "node:fs";
import path from "node:path";
import { POSE_ANCHORS } from "../src/engine/pose-anchors";

const FIXTURES = path.join(process.cwd(), "test/fixtures");

/** 序列帧率。和 detectHz(12) 拉开距离，好验「编号跳变落在检测网格上」而不是每帧一跳 */
const FPS = 30;
const SECONDS = 4;

type Pt = { x: number; y: number; z: number };

/**
 * 把一条手臂绕肩关节转开。
 *
 * 转而不是平移：平移会让手臂变长，肘和腕的相对关系全错，
 * 姿态模型认出来的骨架比例就不成立了 —— 而 spread 是拿它和肩宽比出来的。
 */
function rotateArm(pts: Pt[], shoulder: number, joints: number[], a: number) {
  const o = pts[shoulder];
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (const j of joints) {
    const dx = pts[j].x - o.x;
    const dy = pts[j].y - o.y;
    pts[j] = { x: o.x + dx * c - dy * s, y: o.y + dx * s + dy * c, z: pts[j].z };
  }
}

function main() {
  const name = process.argv[2] ?? "body";
  const file = path.join(FIXTURES, `${name}.pose.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Pt[][] | { fps: number; frames: Pt[][][] };
  const base = Array.isArray(raw) ? raw[0] : raw.frames[0][0];
  if (!base?.length) throw new Error(`${file} 里没有姿态数据，先跑 npm run record:fixture -- ${name}`);

  const A = POSE_ANCHORS;
  const total = FPS * SECONDS;
  const frames: Pt[][][] = [];
  for (let f = 0; f < total; f++) {
    const p = f / (total - 1);
    /*
     * 0 → 最大 → 0 走一趟。两端都停在「手垂着」，这样序列循环播放时
     * 接缝处不会有一次瞬间张开 —— 那会在轨迹类断言上表现成假的爆发。
     */
    const open = Math.sin(Math.PI * p);
    const pts = base.map((q) => ({ ...q }));
    // 本人左手在画面上是右侧，两条手臂要往相反方向转
    rotateArm(pts, A.shoulder_left, [A.elbow_left, A.wrist_left, A.index_left, A.pinky_left, A.thumb_left], -open * 1.5);
    rotateArm(
      pts,
      A.shoulder_right,
      [A.elbow_right, A.wrist_right, A.index_right, A.pinky_right, A.thumb_right],
      open * 1.5,
    );
    frames.push([pts.map((q) => ({ x: +q.x.toFixed(6), y: +q.y.toFixed(6), z: +q.z.toFixed(6) }))]);
  }

  fs.writeFileSync(file, JSON.stringify({ fps: FPS, frames }));

  /*
   * 把实际扫到的 spread 区间打出来。
   *
   * 合成完不验一遍的话，「转了但没转够」会表现成「框没怎么变多」，
   * 而那看起来跟参数没调好一模一样 —— 这个坑在手指弯曲那次已经踩过。
   */
  const spreadOf = (pts: Pt[]) => {
    const d = (a: number, b: number) => Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
    const sw = Math.max(1e-6, d(A.shoulder_left, A.shoulder_right));
    return Math.max(0, Math.min(1, (d(A.wrist_left, A.wrist_right) / sw - 1.2) / 2.3));
  };
  const vals = frames.map((fr) => spreadOf(fr[0]));
  console.log(
    `${path.relative(process.cwd(), file)}  ${total} 帧 @ ${FPS}fps（${SECONDS}s）\n` +
      `实际 spread 区间：${Math.min(...vals).toFixed(2)} → ${Math.max(...vals).toFixed(2)}（手臂开合是合成的，几何是真模型录的）`,
  );
}

main();
