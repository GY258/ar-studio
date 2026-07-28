/**
 * 生成器层。纯函数：生成器 JSON 进 → 平铺 ElementV2 列表出。
 *
 * 运行时不认识生成器。loadTemplate 阶段展开，展开结果与手写平铺列表完全等价——
 * 「摆成心形」这种生成器覆盖不了的排列直接写平铺列表就行，两者没有优劣之分。
 *
 * id 必须确定：同一份 JSON 重复展开要拿到同一串 id，否则 L2 的 golden 对比不成立。
 */

import type { ElementV2 } from "./types";
import { ANCHOR_PAIRS, type FaceAnchorName } from "./anchors";
import type { AnimationV2 } from "./animations";

/** 生成器负责填 id 和 anchor，其余外观由 item 给。 */
export type GeneratorItem = Omit<ElementV2, "id" | "anchor">;

export type GeneratorV2 =
  | {
      generate: "mirrorPair";
      /** 成对锚点名，见 ANCHOR_PAIRS。写 "lower_eyelid" 不是 "lower_eyelid_left" */
      anchor: string;
      /** [x, y] 偏移，单位 IOD。右侧自动取反 x。只作用于 item，不传给 children */
      offset?: [number, number];
      item: GeneratorItem;
      children?: GeneratorV2[];
    }
  | {
      generate: "trail";
      count: number;
      /** 相邻两个之间的 y 间距，单位 IOD */
      step: number;
      /** 逐个缩小的倍率，size.scale 累乘 */
      decay?: number;
      direction?: "down" | "down-out";
      /**
       * 相邻两个的动画起始时间差，单位秒。
       * 展开时换算成归一化 phase：phase_i = base + i * phaseShift / period。
       */
      phaseShift?: number;
      item: GeneratorItem;
    }
  | {
      generate: "columns";
      rows: number;
      sides: "both" | "left" | "right";
      /** 第一行的 [x, y] 偏移，单位 IOD。x 会按 side 取正负 */
      startOffset: [number, number];
      stepY: number;
      driftX?: number;
      /** 逐个替换 asset.text，按 [左0, 右0, 左1, 右1, …] 顺序取 */
      labels?: string[];
      item: GeneratorItem;
    }
  | {
      generate: "scatter";
      count: number;
      /** 必填。没有 seed 展开不确定，golden 对比无从建立 */
      seed: number;
      sizeRange?: [number, number];
      /** >0 时把元素往边缘赶，中间留给人脸 */
      edgeBias?: number;
      item: Omit<GeneratorItem, "size"> & { size?: ElementV2["size"] };
    }
  | {
      generate: "ring";
      count: number;
      /** 半径，单位 IOD */
      radius: number;
      arc?: [number, number];
      tangentRotate?: boolean;
      item: GeneratorItem;
    }
  | {
      generate: "spread";
      count: number;
      /** 总宽度，单位 IOD */
      width: number;
      item: GeneratorItem;
    };

/** Seeded PRNG (mulberry32)，让 scatter 可重现。 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 深拷贝 item，避免多个展开结果共享同一个 asset / animations 对象。 */
function cloneItem(item: GeneratorItem): GeneratorItem {
  return {
    ...item,
    asset: { ...item.asset },
    size: item.size ? { ...item.size } : item.size,
    animations: item.animations?.map((a) => ({ ...a })),
  } as GeneratorItem;
}

function scaled(size: ElementV2["size"], factor: number): ElementV2["size"] {
  return { ref: size.ref, scale: size.scale * factor };
}

/** 把 trail 的秒级 phaseShift 换算成每条动画的归一化 phase。 */
function shiftPhase(anims: AnimationV2[] | undefined, index: number, phaseShift: number): AnimationV2[] | undefined {
  if (!anims || phaseShift === 0) return anims;
  return anims.map((a) => {
    const period = (a as { period?: number }).period;
    if (!period || period <= 0) return a;
    return { ...a, phase: (a.phase ?? 0) + (index * phaseShift) / period };
  });
}

function faceAnchor(
  landmark: string | number,
  offset?: [number, number],
  mirror?: boolean,
): ElementV2["anchor"] {
  return { space: "face", landmark, ...(offset ? { offset } : {}), ...(mirror ? { mirror: true } : {}) };
}

/** 把一个已展开的元素整体镜像到右侧：翻转 x 偏移并打 mirror 标记。 */
function mirrorElement(el: ElementV2, landmark: FaceAnchorName): ElementV2 {
  if (el.anchor.space !== "face") return el;
  const off = el.anchor.offset;
  return {
    ...el,
    anchor: faceAnchor(landmark, off ? [-off[0], off[1]] : undefined, true),
  };
}

/**
 * 展开一个生成器。
 *
 * nextId 由调用方注入，保证同一次 expandGenerators 内部计数连续、跨次调用从头开始。
 * 之前这里用模块级 globalCounter，跨模板累加永不重置，同一个模板在不同加载顺序下
 * 拿到不同的 id —— golden 对比直接失效。
 */
function expand(
  gen: GeneratorV2,
  nextId: (prefix: string) => string,
  parentLandmark?: FaceAnchorName,
): ElementV2[] {
  const result: ElementV2[] = [];

  switch (gen.generate) {
    case "mirrorPair": {
      const pair = ANCHOR_PAIRS[gen.anchor];
      if (!pair) break;
      const [left, right] = pair;

      const off = gen.offset;
      result.push({
        ...cloneItem(gen.item),
        id: nextId(`${gen.anchor}-l`),
        anchor: faceAnchor(left, off),
      } as ElementV2);
      result.push({
        ...cloneItem(gen.item),
        id: nextId(`${gen.anchor}-r`),
        anchor: faceAnchor(right, off ? [-off[0], off[1]] : undefined, true),
      } as ElementV2);

      // 子生成器在每侧各展开一次。左侧原样，右侧整体镜像。
      for (const child of gen.children ?? []) {
        result.push(...expand(child, nextId, left));
        for (const rc of expand(child, nextId, right)) {
          result.push(mirrorElement(rc, right));
        }
      }
      break;
    }

    case "trail": {
      const lm = parentLandmark ?? "nose_bridge";
      const phaseShift = gen.phaseShift ?? 0;
      for (let i = 0; i < gen.count; i++) {
        const item = cloneItem(gen.item);
        const decay = Math.pow(gen.decay ?? 0.9, i);
        // down-out：越往下越往外撇，模拟眼泪顺着脸颊滑开
        const outward = gen.direction === "down-out" ? i * 0.04 : 0;
        result.push({
          ...item,
          id: nextId("trail"),
          anchor: faceAnchor(lm, [outward, i * gen.step]),
          size: scaled(item.size, decay),
          animations: shiftPhase(item.animations, i, phaseShift),
        } as ElementV2);
      }
      break;
    }

    case "columns": {
      const lm = parentLandmark ?? "nose_bridge";
      const sides = gen.sides === "left" ? [-1] : gen.sides === "right" ? [1] : [-1, 1];
      for (let row = 0; row < gen.rows; row++) {
        const drift = (gen.driftX ?? 0.1) * row;
        const y = gen.startOffset[1] + row * gen.stepY;
        for (const side of sides) {
          const item = cloneItem(gen.item);
          const x = (gen.startOffset[0] + drift) * side;
          const idx = sides.length === 1 ? row : side === -1 ? row * 2 : row * 2 + 1;
          const label = gen.labels?.[idx];
          if (label !== undefined && item.asset.kind === "text") item.asset.text = label;
          result.push({ ...item, id: nextId("col"), anchor: faceAnchor(lm, [x, y]) } as ElementV2);
        }
      }
      break;
    }

    case "scatter": {
      // 屏幕空间：「满屏飘」的东西不该跟着脸走
      const rng = mulberry32(gen.seed);
      const [lo, hi] = gen.sizeRange ?? [0.02, 0.06];
      const bias = gen.edgeBias ?? 0;
      let guard = gen.count * 20; // 拒绝采样的兜底，避免 edgeBias 过大时死循环
      for (let i = 0; i < gen.count; i++) {
        const nx = rng();
        const ny = rng();
        const scale = lo + rng() * (hi - lo);
        // 中心离得越近越容易被拒，把位置让给人脸
        const centrality = 1 - Math.abs(nx - 0.5) * 2;
        if (bias > 0 && guard-- > 0 && rng() < centrality * bias) {
          i--;
          continue;
        }
        const item = cloneItem(gen.item as GeneratorItem);
        result.push({
          ...item,
          id: nextId("scat"),
          anchor: { space: "screen", nx, ny },
          size: item.size ?? { ref: "vw", scale },
        } as ElementV2);
      }
      break;
    }

    case "ring": {
      const lm = parentLandmark ?? "nose_bridge";
      const [arcStart, arcEnd] = gen.arc ?? [0, 360];
      for (let i = 0; i < gen.count; i++) {
        const item = cloneItem(gen.item);
        const angle = ((arcStart + (arcEnd - arcStart) * (i / gen.count)) * Math.PI) / 180;
        result.push({
          ...item,
          id: nextId("ring"),
          anchor: faceAnchor(lm, [Math.cos(angle) * gen.radius, Math.sin(angle) * gen.radius]),
          rotation: gen.tangentRotate ? (angle * 180) / Math.PI + 90 : item.rotation,
        } as ElementV2);
      }
      break;
    }

    case "spread": {
      const lm = parentLandmark ?? "nose_bridge";
      for (let i = 0; i < gen.count; i++) {
        const item = cloneItem(gen.item);
        const t = gen.count === 1 ? 0 : i / (gen.count - 1) - 0.5;
        result.push({
          ...item,
          id: nextId("sprd"),
          anchor: faceAnchor(lm, [t * gen.width, 0]),
        } as ElementV2);
      }
      break;
    }
  }

  return result;
}

/** 一条 JSON 里的元素：要么是平铺元素，要么是生成器。 */
export type ElementOrGenerator = ElementV2 | GeneratorV2;

export function isGenerator(e: ElementOrGenerator): e is GeneratorV2 {
  return typeof (e as GeneratorV2).generate === "string";
}

/**
 * 展开一份元素列表里的所有生成器，平铺元素原样通过。
 * 计数器每次调用从 0 开始 —— 确定性靠这一行。
 */
export function expandGenerators(elements: ElementOrGenerator[]): ElementV2[] {
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${counter++}`;

  const out: ElementV2[] = [];
  for (const e of elements) {
    if (isGenerator(e)) out.push(...expand(e, nextId));
    else out.push(e);
  }
  return out;
}
