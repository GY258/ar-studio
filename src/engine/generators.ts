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

/**
 * 逐实例随机扰动。
 *
 * 生成器默认产出一批一模一样的东西 —— crying 的 trail 是 `step:0 + decay:1`，
 * 三滴眼泪起点相同、大小相同，只有相位差，于是沿同一条线单列前进，像流水线上的零件。
 * jitter 就是用来打散这种整齐的。
 *
 * seed 必填，理由和 scatter 那条一样：没有 seed 展开结果不确定，golden 对比无从建立。
 */
export interface Jitter {
  /** 尺寸倍率的随机范围。0.2 = ±20% */
  size?: number;
  /** 归一化相位的随机偏移，作用在 item 的每条动画上 */
  phase?: number;
  /** 位置偏移的随机量，单位 IOD */
  offset?: [number, number];
  /** 必填。没有它就不是可重现的展开 */
  seed: number;
}

/**
 * 生成器负责填 id 和 anchor，其余外观由 item 给。
 * jitter 是展开期指令，不会出现在展开结果里。
 */
export type GeneratorItem = Omit<ElementV2, "id" | "anchor"> & { jitter?: Jitter };

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
      /**
       * 挂在哪个人脸锚点上。只对**顶层** trail 有意义。
       *
       * 嵌在 mirrorPair 里的时候父生成器会把左右两侧的锚点分别传下来，那个优先 ——
       * 不然右侧那串会跟着左侧的锚点跑，镜像就散了。
       * 都没有才回落到 nose_bridge（眼泪那套的原始行为）。
       */
      landmark?: string;
      /**
       * 整串的起点偏移 [x, y]，单位 IOD。
       * 不给的话第一个元素正好压在锚点上——眼泪这种「从泪痕下沿冒出来」的效果
       * 就会变成「从眼睑里穿出来」，水滴顶端戳到横条上面去。
       */
      offset?: [number, number];
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
  // jitter 是展开期指令，不是元素属性，不能漏进平铺结果
  const { jitter: _jitter, ...rest } = item;
  return {
    ...rest,
    asset: { ...item.asset },
    size: item.size ? { ...item.size } : item.size,
    animations: item.animations?.map((a) => ({ ...a })),
  } as GeneratorItem;
}

/** 按 seed 取 rng。同一个 seed 在一次展开里共享一条流，取值顺序 = 展开顺序。 */
export type RngPool = (seed: number) => () => number;

/**
 * 给一个已展开的元素加抖动。
 *
 * **固定抽 4 个随机数**，不管哪几个字段真的写了。按需抽的话，
 * 给 jitter 补一个 size 字段会把后面所有元素的随机流整体移位，
 * 「只想让眼泪大小不一」的一次小改动会让整批位置全变 —— 那种 diff 没法看。
 *
 * 一次展开内左右两侧走的是同一条流的不同区段，所以左右眼的抖动不同。
 * 共用一条流是刻意的：每侧各起一条同 seed 的流会让左右完全镜像对称，
 * 那种「整齐的随机」比不抖还假。
 */
function jittered(el: ElementV2, j: Jitter, rng: () => number): ElementV2 {
  const sym = () => rng() * 2 - 1; // [-1, 1)
  const dSize = sym();
  const dPhase = sym();
  const dx = sym();
  const dy = sym();

  const out: ElementV2 = { ...el };

  if (j.size) out.size = { ...el.size, scale: el.size.scale * (1 + dSize * j.size) };

  if (j.phase && el.animations?.length) {
    out.animations = el.animations.map((a) => ({ ...a, phase: (a.phase ?? 0) + dPhase * j.phase! }));
  }

  if (j.offset && el.anchor.space === "face") {
    const [ox, oy] = el.anchor.offset ?? [0, 0];
    out.anchor = { ...el.anchor, offset: [ox + dx * j.offset[0], oy + dy * j.offset[1]] };
  } else if (j.offset && el.anchor.space === "screen") {
    // screen 空间没有 IOD 可参照，按视口宽度的比例挪。scatter 自己有 seed，
    // 走不到这里；留着是为了将来有 screen 空间的生成器时行为是确定的而不是静默失效。
    out.anchor = { ...el.anchor, nx: el.anchor.nx + dx * j.offset[0], ny: el.anchor.ny + dy * j.offset[1] };
  }

  return out;
}

/** item 声明了 jitter 就抖，没声明原样返回 —— 没声明时一个随机数都不许抽。 */
function maybeJitter(el: ElementV2, item: GeneratorItem, rngFor: RngPool): ElementV2 {
  return item.jitter ? jittered(el, item.jitter, rngFor(item.jitter.seed)) : el;
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
  rngFor: RngPool,
  parentLandmark?: FaceAnchorName,
): ElementV2[] {
  const result: ElementV2[] = [];
  const jit = (el: ElementV2) => maybeJitter(el, gen.item as GeneratorItem, rngFor);

  switch (gen.generate) {
    case "mirrorPair": {
      const pair = ANCHOR_PAIRS[gen.anchor];
      if (!pair) break;
      const [left, right] = pair;

      const off = gen.offset;
      result.push(
        jit({
          ...cloneItem(gen.item),
          id: nextId(`${gen.anchor}-l`),
          anchor: faceAnchor(left, off),
        } as ElementV2),
      );
      result.push(
        jit({
          ...cloneItem(gen.item),
          id: nextId(`${gen.anchor}-r`),
          anchor: faceAnchor(right, off ? [-off[0], off[1]] : undefined, true),
        } as ElementV2),
      );

      // 子生成器在每侧各展开一次。左侧原样，右侧整体镜像。
      for (const child of gen.children ?? []) {
        result.push(...expand(child, nextId, rngFor, left));
        for (const rc of expand(child, nextId, rngFor, right)) {
          result.push(mirrorElement(rc, right));
        }
      }
      break;
    }

    case "trail": {
      const lm = parentLandmark ?? gen.landmark ?? "nose_bridge";
      const phaseShift = gen.phaseShift ?? 0;
      const [baseX, baseY] = gen.offset ?? [0, 0];
      for (let i = 0; i < gen.count; i++) {
        const item = cloneItem(gen.item);
        const decay = Math.pow(gen.decay ?? 0.9, i);
        // down-out：越往下越往外撇，模拟眼泪顺着脸颊滑开
        const outward = gen.direction === "down-out" ? i * 0.04 : 0;
        result.push(
          jit({
            ...item,
            id: nextId("trail"),
            anchor: faceAnchor(lm, [baseX + outward, baseY + i * gen.step]),
            size: scaled(item.size, decay),
            animations: shiftPhase(item.animations, i, phaseShift),
          } as ElementV2),
        );
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
        result.push(
          jit({
            ...item,
            id: nextId("ring"),
            anchor: faceAnchor(lm, [Math.cos(angle) * gen.radius, Math.sin(angle) * gen.radius]),
            rotation: gen.tangentRotate ? (angle * 180) / Math.PI + 90 : item.rotation,
          } as ElementV2),
        );
      }
      break;
    }

    case "spread": {
      const lm = parentLandmark ?? "nose_bridge";
      for (let i = 0; i < gen.count; i++) {
        const item = cloneItem(gen.item);
        const t = gen.count === 1 ? 0 : i / (gen.count - 1) - 0.5;
        result.push(
          jit({
            ...item,
            id: nextId("sprd"),
            anchor: faceAnchor(lm, [t * gen.width, 0]),
          } as ElementV2),
        );
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

  // 每个 seed 一条流，本次展开内共享，取值顺序 = 展开顺序。
  // 每个生成器各起一条同 seed 的新流的话，mirrorPair 的左右两侧会抖得完全一样。
  const pool = new Map<number, () => number>();
  const rngFor: RngPool = (seed) => {
    let rng = pool.get(seed);
    if (!rng) {
      rng = mulberry32(seed);
      pool.set(seed, rng);
    }
    return rng;
  };

  const out: ElementV2[] = [];
  for (const e of elements) {
    if (isGenerator(e)) out.push(...expand(e, nextId, rngFor));
    else out.push(e);
  }
  return out;
}
