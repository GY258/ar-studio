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

const PAINTERS: Record<NonNullable<Emitter["shape"]>, Painter> = { cloud, shower, glass, cup };

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
