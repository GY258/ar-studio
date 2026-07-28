#!/usr/bin/env tsx
/**
 * 生成合成 fixture（画面图 + 478 点 landmark + categoryMask）。
 *
 * 为什么有这个脚本：`record-fixture.ts` 录的是真人照片跑 MediaPipe 的产物，
 * 需要真实照片 + 下载模型 + GPU，开发者本地手动跑一次。但 L2 要验的是
 * 「元素摆在哪、动画对不对」，这部分只依赖 landmark 的数值，不依赖照片真不真。
 * 所以先用几何合成的脸把链路跑通，真 fixture 到位后覆盖同名文件即可，
 * 下游（harness / render.spec）一行都不用改。
 *
 * 产物是确定的：同一份代码永远生成同一批字节，golden 才立得住。
 *
 * 用法：npx tsx scripts/make-fixtures.ts
 */

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { FACE_ANCHORS } from "../src/engine/anchors";

const OUT = path.join(process.cwd(), "test/fixtures");
const W = 960;
const H = 540;
/** categoryMask 的分辨率，MediaPipe 输出的量级 */
const MW = 256;
const MH = 144;

const BG_VAL = 0;
const PERSON_VAL = 255;

type Pt = { x: number; y: number; z: number };

/**
 * 一张脸的几何参数。所有 landmark 都从这里推出来，
 * 换个参数就是换一张脸，不用手填 478 个坐标。
 */
interface FaceShape {
  cx: number;
  cy: number;
  /** 半宽 / 半高，归一化 */
  rx: number;
  ry: number;
  /** 滚转，弧度 */
  roll: number;
}

/** 语义锚点在「标准脸」局部坐标系里的位置，单位是半宽/半高的倍数。 */
const LOCAL: Record<string, [number, number]> = {
  iris_left: [-0.38, -0.16],
  iris_right: [0.38, -0.16],
  lower_eyelid_left: [-0.38, -0.05],
  lower_eyelid_right: [0.38, -0.05],
  upper_eyelid_left: [-0.38, -0.28],
  upper_eyelid_right: [0.38, -0.28],
  eye_outer_left: [-0.66, -0.16],
  eye_outer_right: [0.66, -0.16],
  nose_bridge: [0, -0.08],
  nose_tip: [0, 0.22],
  forehead: [0, -0.62],
  head_top: [0, -0.95],
  chin: [0, 0.94],
  mouth_center: [0, 0.56],
  upper_lip: [0, 0.45],
  lower_lip: [0, 0.66],
  cheek_left: [-0.52, 0.24],
  cheek_right: [0.52, 0.24],
  temple_left: [-0.92, -0.16],
  temple_right: [0.92, -0.16],
  jaw_left: [-0.72, 0.72],
  jaw_right: [0.72, 0.72],
  ear_left: [-1.0, 0.1],
  ear_right: [1.0, 0.1],
};

/** 引擎内部还会用到这几个裸编号（单眼宽度、瞳距），一并给出合理位置。 */
const LOCAL_EXTRA: Record<number, [number, number]> = {
  133: [-0.14, -0.16], // 左眼内眼角
  362: [0.14, -0.16], // 右眼内眼角
};

function build(shape: FaceShape): Pt[] {
  const { cx, cy, rx, ry, roll } = shape;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);

  const place = (lx: number, ly: number): Pt => {
    const px = lx * rx;
    const py = ly * ry;
    return { x: cx + px * cos - py * sin, y: cy + px * sin + py * cos, z: 0 };
  };

  // 先给全部 478 个点一个落在脸廓上的默认位置，
  // 保证任何索引都能取到有意义的坐标，而不是 undefined。
  const pts: Pt[] = Array.from({ length: 478 }, (_, i) => {
    const a = (i / 478) * Math.PI * 2;
    return place(Math.cos(a) * 0.9, Math.sin(a) * 0.9);
  });

  for (const [name, idx] of Object.entries(FACE_ANCHORS)) {
    const local = LOCAL[name];
    if (local) pts[idx as number] = place(local[0], local[1]);
  }
  for (const [idx, local] of Object.entries(LOCAL_EXTRA)) {
    pts[Number(idx)] = place(local[0], local[1]);
  }
  return pts;
}

/* ---------------- 画面 ---------------- */

function inEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number, roll = 0) {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(-roll);
  const sin = Math.sin(-roll);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1;
}

/**
 * 背景画成彩色棋盘格。
 * 纯色背景没法验证马赛克 —— 一块纯色降采样之后还是同一块纯色，
 * 「蒙版外局部方差显著下降」这条断言就恒成立，等于没测。
 */
function bgColor(x: number, y: number, w: number, h: number): [number, number, number] {
  const u = x / w;
  const v = y / h;
  const cell = (Math.floor(u * 24) + Math.floor(v * 14)) % 2;
  const r = cell ? 40 : 210;
  const g = Math.round(60 + 150 * v);
  const b = cell ? 190 : 55;
  return [r, g, b];
}

function renderImage(shape: FaceShape | null, pts: Pt[] | null): PNG {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) << 2;
      let [r, g, b] = bgColor(x, y, W, H);

      if (shape) {
        const nx = x / W;
        const ny = y / H;
        // 身体：脖子以下的梯形，让分割蒙版不只是一个圆
        const bodyTop = shape.cy + shape.ry * 1.0;
        if (ny > bodyTop && Math.abs(nx - shape.cx) < shape.rx * (0.9 + (ny - bodyTop) * 3)) {
          [r, g, b] = [58, 74, 112];
        }
        if (inEllipse(nx, ny, shape.cx, shape.cy, shape.rx, shape.ry, shape.roll)) {
          [r, g, b] = [232, 194, 168];
        }
        if (pts) {
          // 眼睛和嘴巴，纯粹为了人眼看预览图时能判断左右和朝向
          const mark = (p: Pt, rr: number, col: [number, number, number]) => {
            if (Math.hypot(nx - p.x, ny - p.y) < rr) [r, g, b] = col;
          };
          mark(pts[FACE_ANCHORS.iris_left], 0.014, [45, 45, 60]);
          mark(pts[FACE_ANCHORS.iris_right], 0.014, [45, 45, 60]);
          mark(pts[FACE_ANCHORS.mouth_center], 0.020, [178, 92, 92]);
          mark(pts[FACE_ANCHORS.nose_tip], 0.010, [206, 160, 138]);
        }
      }

      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

/** categoryMask：人 = PERSON_VAL，背景 = BG_VAL。四角必须是背景，ingest 靠它定 bgVal。 */
function renderMask(shape: FaceShape | null): PNG {
  const png = new PNG({ width: MW, height: MH });
  for (let y = 0; y < MH; y++) {
    for (let x = 0; x < MW; x++) {
      const i = (y * MW + x) << 2;
      const nx = x / MW;
      const ny = y / MH;
      let v = BG_VAL;
      if (shape) {
        const bodyTop = shape.cy + shape.ry * 1.0;
        const isBody = ny > bodyTop && Math.abs(nx - shape.cx) < shape.rx * (0.9 + (ny - bodyTop) * 3);
        if (isBody || inEllipse(nx, ny, shape.cx, shape.cy, shape.rx, shape.ry, shape.roll)) v = PERSON_VAL;
      }
      png.data[i] = v;
      png.data[i + 1] = v;
      png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

/* ---------------- 四张 fixture ---------------- */

const FIXTURES: Record<string, FaceShape | null> = {
  // 正脸，居中，无滚转
  front: { cx: 0.5, cy: 0.42, rx: 0.15, ry: 0.22, roll: 0 },
  // 侧偏 + 带滚转，验偏移旋转跟不跟头
  side: { cx: 0.38, cy: 0.44, rx: 0.115, ry: 0.21, roll: 0.14 },
  // 远景，IOD 变小，验 size.ref 的 iod / vw 差别
  far: { cx: 0.56, cy: 0.36, rx: 0.072, ry: 0.105, roll: -0.05 },
  // 空场景，验丢脸兜底
  noface: null,
};

fs.mkdirSync(OUT, { recursive: true });

for (const [name, shape] of Object.entries(FIXTURES)) {
  const pts = shape ? build(shape) : null;

  fs.writeFileSync(path.join(OUT, `${name}.png`), PNG.sync.write(renderImage(shape, pts)));
  fs.writeFileSync(path.join(OUT, `${name}.mask.png`), PNG.sync.write(renderMask(shape)));
  fs.writeFileSync(
    path.join(OUT, `${name}.landmarks.json`),
    JSON.stringify(
      pts ? pts.map((p) => ({ x: round(p.x), y: round(p.y), z: 0 })) : null,
    ) + "\n",
  );

  const iod = pts
    ? Math.hypot(
        (pts[FACE_ANCHORS.iris_right].x - pts[FACE_ANCHORS.iris_left].x) * W,
        (pts[FACE_ANCHORS.iris_right].y - pts[FACE_ANCHORS.iris_left].y) * H,
      )
    : 0;
  console.log(`✓ ${name}  ${pts ? `478 点，IOD ≈ ${iod.toFixed(1)}px` : "无人脸"}`);
}

function round(v: number) {
  return Math.round(v * 1e6) / 1e6;
}

console.log(`\nfixture 写到 ${path.relative(process.cwd(), OUT)}/`);
console.log("真实照片的 fixture 用 npm run record:fixture 覆盖同名文件。");
