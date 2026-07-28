/**
 * 生成器层。纯函数：生成器 JSON 进 → 平铺元素列表出。
 *
 * 运行时不认识生成器。loadTemplate 阶段展开，展开结果与手写平铺列表完全等价。
 * LLM 先用平铺列表跑通全链路，再用生成器提高可靠性和简洁度。
 */

import type { FaceTrackElement } from "./types";
import { ANCHOR_PAIRS, type FaceAnchorName } from "./anchors";

export type GeneratorV2 =
  | { generate: "mirrorPair"; anchor: string;
      item: Omit<FaceTrackElement, "id" | "landmark">;
      children?: GeneratorV2[] }
  | { generate: "trail"; count: number; step: number; decay?: number;
      direction?: "down" | "down-out";
      item: Omit<FaceTrackElement, "id" | "landmark"> }
  | { generate: "columns"; rows: number; sides: "both" | "left" | "right";
      startOffset: [number, number]; stepY: number; driftX?: number;
      item: Omit<FaceTrackElement, "id" | "landmark">;
      labels?: string[] }
  | { generate: "scatter"; count: number; seed: number;
      sizeRange?: [number, number]; edgeBias?: number;
      item: Omit<FaceTrackElement, "id" | "landmark" | "iodScale"> }
  | { generate: "ring"; count: number; radius: number; arc?: [number, number];
      tangentRotate?: boolean;
      item: Omit<FaceTrackElement, "id" | "landmark"> }
  | { generate: "spread"; count: number; width: number;
      item: Omit<FaceTrackElement, "id" | "landmark"> };

let globalCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${globalCounter++}`;
}

/** Seeded PRNG (mulberry32) for deterministic scatter */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 展开一个生成器为平铺元素列表。anchor 由父级传入。 */
export function expandGenerator(
  gen: GeneratorV2,
  parentLandmark?: FaceAnchorName,
): FaceTrackElement[] {
  const result: FaceTrackElement[] = [];

  switch (gen.generate) {
    case "mirrorPair": {
      const pair = ANCHOR_PAIRS[gen.anchor];
      if (!pair) break;
      const [left, right] = pair;

      // 左侧
      result.push({
        ...gen.item,
        id: nextId(`${gen.anchor}-l`),
        landmark: left,
      });
      // 右侧（镜像）
      result.push({
        ...gen.item,
        id: nextId(`${gen.anchor}-r`),
        landmark: right,
        mirror: true,
        offsetX: gen.item.offsetX ? -gen.item.offsetX : undefined,
      });

      // 子生成器在每侧展开
      if (gen.children) {
        for (const child of gen.children) {
          result.push(...expandGenerator(child, left));
          const rightChildren = expandGenerator(child, right);
          for (const rc of rightChildren) {
            rc.mirror = true;
            if (rc.offsetX) rc.offsetX = -rc.offsetX;
          }
          result.push(...rightChildren);
        }
      }
      break;
    }

    case "trail": {
      const lm = parentLandmark ?? "nose_bridge";
      for (let i = 0; i < gen.count; i++) {
        const decay = Math.pow(gen.decay ?? 0.9, i);
        const outward = gen.direction === "down-out" ? i * 0.04 : 0;
        result.push({
          ...gen.item,
          id: nextId("trail"),
          landmark: lm,
          iodScale: (gen.item.iodScale ?? 0.1) * decay,
          offsetX: (gen.item.offsetX ?? 0) + outward,
          offsetY: (gen.item.offsetY ?? 0) + i * gen.step,
        });
      }
      break;
    }

    case "columns": {
      const lm = parentLandmark ?? "nose_bridge";
      for (let row = 0; row < gen.rows; row++) {
        const drift = (gen.driftX ?? 0.1) * row;
        const y = gen.startOffset[1] + row * gen.stepY;
        const sides = gen.sides === "left" ? [-1] : gen.sides === "right" ? [1] : [-1, 1];
        for (const side of sides) {
          const x = gen.startOffset[0] * side + drift * side;
          const idx = side === -1 ? row * 2 : row * 2 + 1;
          const label = gen.labels?.[idx];
          result.push({
            ...gen.item,
            id: nextId("col"),
            landmark: lm,
            offsetX: x,
            offsetY: y,
            text: label ?? gen.item.text,
          });
        }
      }
      break;
    }

    case "scatter": {
      const rng = mulberry32(gen.seed);
      const [lo, hi] = gen.sizeRange ?? [0.02, 0.06];
      for (let i = 0; i < gen.count; i++) {
        const nx = rng();
        const ny = rng();
        const size = lo + rng() * (hi - lo);
        // Edge bias: higher probability near edges
        const edged = gen.edgeBias ?? 1;
        const cx = Math.abs(nx - 0.5) * 2; // 0=center, 1=edge
        if (rng() > cx * edged && cx < 0.3) { // reject center if edgeBias
          i--;
          continue;
        }
        result.push({
          ...gen.item,
          id: nextId("scat"),
          landmark: parentLandmark ?? "nose_bridge",
          offsetX: (nx - 0.5) * 4,
          offsetY: (ny - 0.5) * 6,
          iodScale: size,
        });
      }
      break;
    }

    case "ring": {
      const lm = parentLandmark ?? "nose_bridge";
      const [arcStart, arcEnd] = gen.arc ?? [0, 360];
      for (let i = 0; i < gen.count; i++) {
        const angle = (arcStart + (arcEnd - arcStart) * (i / gen.count)) * Math.PI / 180;
        result.push({
          ...gen.item,
          id: nextId("ring"),
          landmark: lm,
          offsetX: Math.cos(angle) * gen.radius,
          offsetY: Math.sin(angle) * gen.radius,
          rotation: gen.tangentRotate ? (angle * 180 / Math.PI + 90) : gen.item.rotation,
        });
      }
      break;
    }

    case "spread": {
      const lm = parentLandmark ?? "nose_bridge";
      for (let i = 0; i < gen.count; i++) {
        const t = gen.count === 1 ? 0 : (i / (gen.count - 1)) - 0.5;
        result.push({
          ...gen.item,
          id: nextId("sprd"),
          landmark: lm,
          offsetX: (gen.item.offsetX ?? 0) + t * gen.width,
        });
      }
      break;
    }
  }

  return result;
}

/** 展开模板 JSON 中所有生成器。每次调用重置计数器确保确定性。 */
export function expandGenerators(generators: GeneratorV2[]): FaceTrackElement[] {
  globalCounter = 0; // 重置，保证同一模板重复展开 id 一致
  const result: FaceTrackElement[] = [];
  for (const gen of generators) {
    result.push(...expandGenerator(gen));
  }
  return result;
}
