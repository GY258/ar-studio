/**
 * 粒子贴图集。和 props.ts 一样是程序化现画的，零外部素材。
 *
 * 一套贴图 = 一张 4×4 的图集 + 每格的抽取权重和相对大小。粒子发射时按权重抽一格，
 * 着色器按格子号去图集里取 —— 一个 draw call 画完所有糖果。
 *
 * 画风：粗深紫描边 + 饱和填色 + 一块白高光。描边是给浅色背景准备的，
 * 和 particles.ts 里圆点那圈暗边是同一个理由：白墙前面不描边的糖果读不出形状。
 */

import type { SpriteSet } from "./types";

export const ATLAS_GRID = 4;
const CELL = 128;

type Painter = (g: CanvasRenderingContext2D) => void;

export interface SpriteDef {
  paint: Painter;
  /** 抽中的相对概率 */
  weight: number;
  /** 相对大小，乘到 SpriteSet.size 上。星星比南瓜小 */
  scale: number;
}

const INK = "#2A1830";
const LINE = 6;

/** 每个 painter 都画在以 (0,0) 为中心、半宽约 52 的坐标系里，留边防止 mipmap 串格。 */
function ink(g: CanvasRenderingContext2D, fill: string) {
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = LINE;
  g.lineJoin = "round";
  g.lineCap = "round";
  g.strokeStyle = INK;
  g.stroke();
}

function gloss(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = -0.6) {
  g.fillStyle = "rgba(255,255,255,.75)";
  g.beginPath();
  g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  g.fill();
}

function circle(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
}

const pumpkin: Painter = (g) => {
  g.fillStyle = "#4E7A2A";
  g.beginPath();
  g.roundRect(-6, -50, 12, 18, 4);
  ink(g, "#5E8C33");
  for (const [x, rx] of [
    [-20, 26],
    [20, 26],
    [0, 26],
  ] as const) {
    g.beginPath();
    g.ellipse(x, 6, rx, 38, 0, 0, Math.PI * 2);
    ink(g, "#F2801F");
  }
  g.fillStyle = INK;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(s * 8, -6);
    g.lineTo(s * 26, -6);
    g.lineTo(s * 17, -20);
    g.closePath();
    g.fill();
  }
  g.beginPath();
  g.moveTo(-28, 12);
  g.quadraticCurveTo(0, 38, 28, 12);
  g.lineTo(18, 16);
  g.lineTo(12, 10);
  g.lineTo(4, 18);
  g.lineTo(-4, 10);
  g.lineTo(-12, 18);
  g.lineTo(-18, 10);
  g.closePath();
  g.fill();
  gloss(g, -26, -14, 7, 12, 0.3);
};

const witchHat: Painter = (g) => {
  g.beginPath();
  g.ellipse(0, 30, 52, 14, 0, 0, Math.PI * 2);
  ink(g, "#3B2557");
  g.beginPath();
  g.moveTo(-30, 30);
  g.quadraticCurveTo(-14, -10, 6, -48);
  g.quadraticCurveTo(18, -46, 24, -36);
  g.quadraticCurveTo(16, -30, 14, -20);
  g.quadraticCurveTo(22, 4, 30, 30);
  g.closePath();
  ink(g, "#6A3FA0");
  g.beginPath();
  g.moveTo(-26, 18);
  g.quadraticCurveTo(0, 24, 27, 18);
  g.lineTo(29, 28);
  g.quadraticCurveTo(0, 34, -29, 28);
  g.closePath();
  ink(g, "#F7931E");
  gloss(g, -10, -2, 5, 14, 0.5);
};

const eyeball: Painter = (g) => {
  circle(g, 0, 0, 46);
  ink(g, "#FBF6EE");
  g.strokeStyle = "#E0505A";
  g.lineWidth = 2.5;
  for (const a of [0.4, 1.3, 2.6, 3.7, 4.6, 5.6]) {
    g.beginPath();
    g.moveTo(Math.cos(a) * 42, Math.sin(a) * 42);
    g.quadraticCurveTo(Math.cos(a + 0.2) * 34, Math.sin(a + 0.2) * 34, Math.cos(a) * 26, Math.sin(a) * 26);
    g.stroke();
  }
  circle(g, 0, 0, 22);
  g.fillStyle = "#3FA8C9";
  g.fill();
  circle(g, 0, 0, 11);
  g.fillStyle = INK;
  g.fill();
  gloss(g, -9, -9, 6, 5, 0);
  gloss(g, -26, -22, 8, 5);
};

function wrapped(main: string, stripe: string): Painter {
  return (g) => {
    g.rotate(-0.5);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(s * 22, 0);
      g.lineTo(s * 52, -22);
      g.quadraticCurveTo(s * 44, 0, s * 52, 22);
      g.closePath();
      ink(g, main);
    }
    g.beginPath();
    g.ellipse(0, 0, 30, 24, 0, 0, Math.PI * 2);
    ink(g, main);
    g.save();
    g.beginPath();
    g.ellipse(0, 0, 27, 21, 0, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = stripe;
    for (let x = -40; x < 40; x += 16) {
      g.beginPath();
      g.moveTo(x, -30);
      g.lineTo(x + 7, -30);
      g.lineTo(x + 21, 30);
      g.lineTo(x + 14, 30);
      g.closePath();
      g.fill();
    }
    g.restore();
    g.beginPath();
    g.ellipse(0, 0, 30, 24, 0, 0, Math.PI * 2);
    g.lineWidth = LINE;
    g.strokeStyle = INK;
    g.stroke();
    gloss(g, -12, -10, 9, 5, -0.2);
  };
}

const bat: Painter = (g) => {
  g.beginPath();
  g.moveTo(0, -8);
  g.quadraticCurveTo(-22, -30, -54, -14);
  g.quadraticCurveTo(-46, -4, -48, 8);
  g.quadraticCurveTo(-38, 0, -32, 12);
  g.quadraticCurveTo(-22, 4, -16, 18);
  g.quadraticCurveTo(-8, 10, 0, 16);
  g.quadraticCurveTo(8, 10, 16, 18);
  g.quadraticCurveTo(22, 4, 32, 12);
  g.quadraticCurveTo(38, 0, 48, 8);
  g.quadraticCurveTo(46, -4, 54, -14);
  g.quadraticCurveTo(22, -30, 0, -8);
  g.closePath();
  ink(g, "#2E2238");
  g.beginPath();
  g.moveTo(-10, -12);
  g.lineTo(-12, -26);
  g.lineTo(-3, -16);
  g.lineTo(3, -16);
  g.lineTo(12, -26);
  g.lineTo(10, -12);
  g.ellipse(0, -4, 13, 14, 0, -0.3, Math.PI + 0.3, true);
  g.closePath();
  ink(g, "#2E2238");
  g.fillStyle = "#FFB02E";
  circle(g, -5, -6, 3.5);
  g.fill();
  circle(g, 5, -6, 3.5);
  g.fill();
};

const lollipop: Painter = (g) => {
  g.rotate(0.35);
  g.beginPath();
  g.roundRect(-4, 10, 8, 44, 4);
  ink(g, "#FBF6EE");
  circle(g, 0, -14, 32);
  ink(g, "#FBF6EE");
  g.strokeStyle = "#8E4FC9";
  g.lineWidth = 9;
  g.beginPath();
  for (let a = 0; a < Math.PI * 5.2; a += 0.1) {
    const r = 3 + a * 1.6;
    const x = Math.cos(a) * r;
    const y = -14 + Math.sin(a) * r;
    if (a === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  circle(g, 0, -14, 32);
  g.lineWidth = LINE;
  g.strokeStyle = INK;
  g.stroke();
  gloss(g, -14, -28, 8, 5);
};

const candyCorn: Painter = (g) => {
  g.rotate(0.25);
  const path = () => {
    g.beginPath();
    g.moveTo(0, -46);
    g.quadraticCurveTo(10, -40, 30, 26);
    g.quadraticCurveTo(0, 42, -30, 26);
    g.quadraticCurveTo(-10, -40, 0, -46);
    g.closePath();
  };
  path();
  g.fillStyle = "#FBF6EE";
  g.fill();
  g.save();
  path();
  g.clip();
  g.fillStyle = "#F7931E";
  g.fillRect(-40, -18, 80, 30);
  g.fillStyle = "#FFD23F";
  g.fillRect(-40, 12, 80, 40);
  g.restore();
  path();
  g.lineWidth = LINE;
  g.strokeStyle = INK;
  g.stroke();
  gloss(g, -9, -18, 4, 10, 0.2);
};

const skullPop: Painter = (g) => {
  g.rotate(-0.25);
  g.beginPath();
  g.roundRect(-4, 18, 8, 36, 4);
  ink(g, "#FBF6EE");
  circle(g, 0, -8, 34);
  ink(g, "#F7931E");
  g.fillStyle = INK;
  g.beginPath();
  g.ellipse(-12, -12, 7, 9, 0, 0, Math.PI * 2);
  g.ellipse(12, -12, 7, 9, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(0, -2);
  g.lineTo(-4, 5);
  g.lineTo(4, 5);
  g.closePath();
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.beginPath();
  g.moveTo(-12, 13);
  g.lineTo(12, 13);
  for (const x of [-6, 0, 6]) {
    g.moveTo(x, 9);
    g.lineTo(x, 17);
  }
  g.stroke();
  gloss(g, -20, -26, 7, 4);
};

const twist: Painter = (g) => {
  g.rotate(0.7);
  g.beginPath();
  g.roundRect(-13, -50, 26, 100, 13);
  g.fillStyle = "#FBF6EE";
  g.fill();
  g.save();
  g.clip();
  g.fillStyle = "#E8414B";
  for (let y = -70; y < 60; y += 22) {
    g.beginPath();
    g.moveTo(-20, y);
    g.lineTo(20, y + 16);
    g.lineTo(20, y + 26);
    g.lineTo(-20, y + 10);
    g.closePath();
    g.fill();
  }
  g.restore();
  g.beginPath();
  g.roundRect(-13, -50, 26, 100, 13);
  g.lineWidth = LINE;
  g.strokeStyle = INK;
  g.stroke();
  gloss(g, -5, -30, 3, 10, 0);
};

const berries: Painter = (g) => {
  for (const [x, y] of [
    [-28, 28],
    [-9, 9],
    [10, -10],
    [29, -29],
  ] as const) {
    circle(g, x, y, 16);
    ink(g, "#7B46B8");
    gloss(g, x - 5, y - 6, 4, 3);
  }
};

const star: Painter = (g) => {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 22 : 48;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fillStyle = "#FFD23F";
  g.fill();
  g.lineWidth = 5;
  g.lineJoin = "round";
  g.strokeStyle = "#E8891C";
  g.stroke();
  gloss(g, -8, -14, 5, 8, 0.4);
};

function gumball(fill: string, spots: string): Painter {
  return (g) => {
    circle(g, 0, 0, 40);
    ink(g, fill);
    g.fillStyle = spots;
    for (const [x, y, r] of [
      [14, 10, 6],
      [-12, 18, 5],
      [18, -14, 4],
      [-2, -2, 4],
    ] as const) {
      circle(g, x, y, r);
      g.fill();
    }
    gloss(g, -16, -18, 10, 6);
  };
}

const ghost: Painter = (g) => {
  g.beginPath();
  g.moveTo(-34, 44);
  g.lineTo(-34, -6);
  g.bezierCurveTo(-34, -60, 34, -60, 34, -6);
  g.lineTo(34, 44);
  g.quadraticCurveTo(24, 34, 17, 46);
  g.quadraticCurveTo(8, 34, 0, 46);
  g.quadraticCurveTo(-8, 34, -17, 46);
  g.quadraticCurveTo(-24, 34, -34, 44);
  g.closePath();
  ink(g, "#FBF6EE");
  g.fillStyle = INK;
  g.beginPath();
  g.ellipse(-11, -10, 5, 8, 0, 0, Math.PI * 2);
  g.ellipse(11, -10, 5, 8, 0, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.beginPath();
  g.arc(0, 4, 7, 0.3, Math.PI - 0.3);
  g.stroke();
};

const HALLOWEEN: SpriteDef[] = [
  { paint: pumpkin, weight: 1.2, scale: 1.15 },
  { paint: witchHat, weight: 0.7, scale: 1.2 },
  { paint: eyeball, weight: 0.9, scale: 0.9 },
  { paint: wrapped("#F7931E", "#FBF6EE"), weight: 1.4, scale: 1.05 },
  { paint: wrapped("#4DB35A", "#B9F07A"), weight: 1, scale: 0.95 },
  { paint: wrapped("#8E4FC9", "#E3C8FF"), weight: 1, scale: 0.95 },
  { paint: bat, weight: 0.7, scale: 1.2 },
  { paint: lollipop, weight: 0.8, scale: 1.05 },
  { paint: candyCorn, weight: 1, scale: 0.85 },
  { paint: skullPop, weight: 0.8, scale: 1 },
  { paint: twist, weight: 0.8, scale: 1 },
  { paint: berries, weight: 0.6, scale: 1 },
  // 星星是点缀：抽得多但个头小，填在大糖果之间的空里
  { paint: star, weight: 2.2, scale: 0.45 },
  { paint: gumball("#4DB35A", "#2E6B33"), weight: 0.6, scale: 0.6 },
  { paint: gumball("#F7931E", "#C25A0E"), weight: 0.6, scale: 0.6 },
  { paint: ghost, weight: 0.4, scale: 0.9 },
];

const SETS: Record<SpriteSet["set"], SpriteDef[]> = { "halloween-candy": HALLOWEEN };

export function spriteDefs(set: SpriteSet["set"]): SpriteDef[] {
  return SETS[set];
}

/** 画一张图集。512×512，按 ATLAS_GRID 排格，第 i 个贴图在第 i 格（行优先，从上往下）。 */
export function spriteAtlas(set: SpriteSet["set"]): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = CELL * ATLAS_GRID;
  const g = c.getContext("2d");
  if (!g) return c;
  SETS[set].forEach((d, i) => {
    g.save();
    g.translate((i % ATLAS_GRID) * CELL + CELL / 2, Math.floor(i / ATLAS_GRID) * CELL + CELL / 2);
    d.paint(g);
    g.restore();
  });
  return c;
}
