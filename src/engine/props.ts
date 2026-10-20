/**
 * 程序化道具贴图。零外部素材——模板 JSON 里不给 asset 就现画。
 *
 * 上线换成设计出的 webp 时，只需要在模板 JSON 里填 emitter.asset，
 * 引擎和这个文件都不用动。
 */

import type { Emitter } from "./types";

/** 倾倒角。杯口必须真的朝下，否则是「一个歪着的杯子在漏水」。 */
const POUR = 2.15;

type Painter = (g: CanvasRenderingContext2D, w: number, h: number) => void;

const cloud: Painter = (g, w, h) => {
  g.fillStyle = "rgba(255,255,255,.92)";
  const blobs: [number, number, number][] = [
    [0.2, 0.62, 0.19],
    [0.36, 0.44, 0.24],
    [0.55, 0.42, 0.26],
    [0.72, 0.56, 0.21],
    [0.86, 0.66, 0.15],
    [0.46, 0.68, 0.24],
  ];
  for (const [x, y, r] of blobs) {
    g.beginPath();
    g.ellipse(x * w, y * h, r * w * 0.6, r * h * 1.25, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "rgba(190,190,215,.5)"; // 底面压暗，云才有厚度
  g.beginPath();
  g.ellipse(0.5 * w, 0.8 * h, 0.42 * w, 0.14 * h, 0, 0, Math.PI * 2);
  g.fill();
};

const shower: Painter = (g, w, h) => {
  g.strokeStyle = "#B9BCC6";
  g.lineWidth = w * 0.055;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(w * 0.14, h * 0.1);
  g.lineTo(w * 0.42, h * 0.1);
  g.quadraticCurveTo(w * 0.6, h * 0.1, w * 0.6, h * 0.34);
  g.stroke();

  g.fillStyle = "#C9CCD6";
  g.beginPath();
  g.moveTo(w * 0.28, h * 0.62);
  g.lineTo(w * 0.92, h * 0.62);
  g.lineTo(w * 0.84, h * 0.4);
  g.lineTo(w * 0.36, h * 0.4);
  g.closePath();
  g.fill();

  g.fillStyle = "#8A8E99";
  g.beginPath();
  g.roundRect(w * 0.26, h * 0.6, w * 0.68, h * 0.1, h * 0.05);
  g.fill();

  g.fillStyle = "#5A5E68";
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    g.arc(w * (0.32 + i * 0.075), h * 0.68, w * 0.014, 0, Math.PI * 2);
    g.fill();
  }
};

const glass: Painter = (g, w, h) => {
  g.save();
  g.translate(w * 0.48, h * 0.46);
  g.rotate(POUR);
  g.fillStyle = "rgba(150,205,255,.42)";
  g.beginPath();
  g.moveTo(-w * 0.16, -h * 0.26);
  g.lineTo(w * 0.16, -h * 0.26);
  g.lineTo(w * 0.12, h * 0.26);
  g.lineTo(-w * 0.12, h * 0.26);
  g.closePath();
  g.fill();
  g.strokeStyle = "rgba(235,248,255,.9)";
  g.lineWidth = w * 0.022;
  g.stroke();
  g.fillStyle = "rgba(120,190,255,.55)"; // 杯口那汪水，正要出来
  g.beginPath();
  g.ellipse(0, -h * 0.235, w * 0.155, h * 0.05, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
};

const cup: Painter = (g, w, h) => {
  g.save();
  g.translate(w * 0.48, h * 0.46);
  g.rotate(POUR);
  g.strokeStyle = "#F2EFE9"; // 把手先画，压在杯身下面
  g.lineWidth = w * 0.045;
  g.beginPath();
  g.arc(w * 0.2, -h * 0.02, w * 0.1, -1.2, 1.2);
  g.stroke();
  g.fillStyle = "#F2EFE9";
  g.beginPath();
  g.roundRect(-w * 0.17, -h * 0.24, w * 0.34, h * 0.46, [w * 0.03, w * 0.03, w * 0.06, w * 0.06]);
  g.fill();
  g.fillStyle = "#6B4426";
  g.beginPath();
  g.ellipse(0, -h * 0.23, w * 0.165, h * 0.055, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
};

/**
 * 床单鬼端着马克杯往下倒。鬼在左上，杯口朝右下 —— 模板的 port 要对准杯口，
 * 改了这里的杯子位置记得同步改 JSON 里的 port。
 */
const ghost: Painter = (g, w, h) => {
  const s = w / 512;
  const INK = "#2A1830";
  g.save();
  g.scale(s, s);
  g.lineJoin = "round";
  g.lineCap = "round";
  g.lineWidth = 9;
  g.strokeStyle = INK;

  // 身子：圆顶 + 往右下飘的床单，下摆三道波浪
  const body = () => {
    g.beginPath();
    g.moveTo(70, 300);
    g.bezierCurveTo(40, 220, 60, 70, 180, 50);
    g.bezierCurveTo(290, 34, 330, 130, 318, 210);
    g.bezierCurveTo(312, 260, 330, 300, 350, 330);
    g.quadraticCurveTo(318, 336, 300, 362);
    g.quadraticCurveTo(268, 330, 236, 376);
    g.quadraticCurveTo(200, 336, 160, 372);
    g.quadraticCurveTo(130, 330, 96, 350);
    g.quadraticCurveTo(70, 340, 70, 300);
    g.closePath();
  };
  body();
  g.fillStyle = "#FBF7F2";
  g.fill();
  // 背光面压一层淡紫，床单才有体积
  g.save();
  body();
  g.clip();
  g.fillStyle = "rgba(196,184,214,.55)";
  g.beginPath();
  g.ellipse(80, 290, 70, 120, 0.3, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(250, 360, 120, 40, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  body();
  g.stroke();
  // 床单褶子
  g.lineWidth = 5;
  g.strokeStyle = "rgba(42,24,48,.35)";
  g.beginPath();
  g.moveTo(150, 260);
  g.quadraticCurveTo(160, 310, 158, 360);
  g.moveTo(230, 270);
  g.quadraticCurveTo(240, 320, 236, 368);
  g.stroke();

  // 脸
  g.fillStyle = INK;
  g.beginPath();
  g.ellipse(196, 150, 13, 20, 0, 0, Math.PI * 2);
  g.ellipse(258, 146, 13, 20, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(200, 142, 5, 0, Math.PI * 2);
  g.arc(262, 138, 5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "rgba(255,140,150,.45)";
  g.beginPath();
  g.ellipse(176, 186, 15, 8, 0, 0, Math.PI * 2);
  g.ellipse(282, 180, 15, 8, 0, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = INK;
  g.beginPath();
  g.arc(228, 178, 14, 0.35, Math.PI - 0.35);
  g.stroke();

  // 杯子：倒着拿，杯口朝右下
  g.save();
  g.translate(372, 246);
  g.rotate(-0.95);
  g.lineWidth = 9;
  g.strokeStyle = INK;
  // 把手：在杯身侧面（转过去之后朝右上）
  g.lineWidth = 14;
  g.beginPath();
  g.arc(56, -12, 28, -Math.PI / 2, Math.PI / 2);
  g.stroke();
  g.lineWidth = 6;
  g.strokeStyle = "#FBF7F2";
  g.beginPath();
  g.arc(56, -12, 28, -Math.PI / 2 + 0.15, Math.PI / 2 - 0.15);
  g.stroke();
  g.lineWidth = 9;
  g.strokeStyle = INK;
  g.beginPath();
  g.roundRect(-56, -70, 112, 120, [10, 10, 22, 22]);
  g.fillStyle = "#FBF7F2";
  g.fill();
  g.stroke();
  g.fillStyle = "rgba(196,184,214,.6)";
  g.fillRect(24, -62, 26, 104);
  // 杯口和里面那一层糖
  g.beginPath();
  g.ellipse(0, 50, 56, 18, 0, 0, Math.PI * 2);
  g.fillStyle = "#4A2A1E";
  g.fill();
  g.stroke();
  for (const [x, c] of [
    [-26, "#F7931E"],
    [0, "#8E4FC9"],
    [24, "#4DB35A"],
  ] as const) {
    g.beginPath();
    g.arc(x, 52, 9, 0, Math.PI * 2);
    g.fillStyle = c;
    g.fill();
  }
  g.restore();

  // 抓着杯子的那只「手」：床单伸出来的一截，压在杯身上
  g.beginPath();
  g.moveTo(300, 250);
  g.quadraticCurveTo(340, 236, 372, 262);
  g.quadraticCurveTo(366, 290, 330, 292);
  g.quadraticCurveTo(306, 290, 300, 276);
  g.closePath();
  g.fillStyle = "#FBF7F2";
  g.fill();
  g.lineWidth = 9;
  g.strokeStyle = INK;
  g.stroke();
  g.restore();
};

const PAINTERS: Record<NonNullable<Emitter["shape"]>, Painter> = { cloud, shower, glass, cup, ghost };

export function paintProp(shape: NonNullable<Emitter["shape"]>, canvas: HTMLCanvasElement) {
  const g = canvas.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, canvas.width, canvas.height);
  PAINTERS[shape](g, canvas.width, canvas.height);
}

/** 给道具做一张贴图。宽度固定 512，高度按 aspect 算。 */
export function propCanvas(shape: NonNullable<Emitter["shape"]>, aspect: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = Math.round(512 * aspect);
  paintProp(shape, c);
  return c;
}
