/**
 * 模板 schema（PRD 5.3）。
 *
 * 引擎只认这里的类型，不认具体模板。加「莲蓬头」和加「咖啡杯」对代码是同一件事。
 * 新创意超出表达能力时，扩展这个 schema，而不是在引擎里写 if (slug === "...")。
 */

export type LocalizedText = { zh: string; en?: string };

/** 物质：决定粒子怎么动、怎么撞、怎么画。雪和水不是换颜色，是两套参数。 */
export interface Substance {
  gravity: number;
  friction: number;
  streak: number;
  color: [number, number, number];
  size: [number, number];
  speed: [number, number];
  spread: number;
  splash: number;
  settle: boolean;
  twinkle: boolean;
}

/** 发射器（道具）。asset 缺省时用内置的程序化贴图，零外部素材也能跑。 */
export interface Emitter {
  asset?: string;
  shape?: "cloud" | "shower" | "glass" | "cup";
  aspect: number;
  port: { x: number; y: number };
  band: number;
  tilt?: number;
  draggable: boolean;
  default: { x: number; y: number };
}

export type SubstanceKnob =
  | "gravity"
  | "friction"
  | "streak"
  | "size"
  | "speed"
  | "spread"
  | "splash";

export type ControlTarget = "rate" | "wind" | "stick" | `substance.${SubstanceKnob}`;

export interface Control {
  key: string;
  label: LocalizedText;
  min: number;
  max: number;
  default: number;
  step?: number;
  target?: ControlTarget;
  mode?: "absolute" | "scale";
}

export type Perception = "segmentation" | "face" | "hands";

export interface TemplateListing {
  slug: string;
  name: LocalizedText;
  category: string;
  priceCents: number;
  preview: { poster?: string; video?: string; shape?: Emitter["shape"]; thumb?: string };
  locked: boolean;
}

/* ============================================================
 * 模板类型：particle（原有）/ overlay（贴纸）/ facetrack（人脸追踪）
 * ============================================================ */

export type TemplateType = "particle" | "overlay" | "facetrack";

/* ------------------------------------------------------------
 * ElementV2 —— overlay 与 facetrack 共用的唯一元素类型
 *
 * 三个维度彼此正交，不要互相耦合：
 *   asset  画什么   （svg / 文字 / 渐变）
 *   anchor 画在哪   （屏幕归一化坐标 / 人脸锚点）
 *   size   画多大   （参照物 × 倍数）
 *
 * 「跟着脸平移但按屏幕定大小」= anchor.space:"face" + size.ref:"vw"，
 * 是合法且常用的组合。不要因为 anchor 是 face 就假定 size 一定是 iod。
 * ------------------------------------------------------------ */

export type AnchorSpace = "screen" | "face";

/** 尺寸参照物。face_width / eye_width 由 landmark 实测，人退远会一起缩小；vw 不会。 */
export type SizeRef = "vw" | "iod" | "eye_width" | "face_width";

/**
 * scale 到底在量什么。
 *
 * width —— 元素画出来有多宽，高度按素材比例推。svg / gradient 只有这一种含义。
 * font  —— 字号有多大，宽度由内容长度决定。只对 text 有意义。
 *
 * 两种对文字都成立且都有人要：「这行字占屏幕 1/3 宽」和「这行字 28px 高」
 * 是两个不同的诉求，猜哪个都会猜错，所以让 JSON 自己说。
 */
export type SizeFit = "width" | "font";

/**
 * 元素与背后画面的混合方式。
 *
 * 默认 normal —— 一块不透明的色块糊在脸上。真实的眼泪是折射的，颜色主要来自
 * 它背后的皮肤；腮红是长在皮肤上的红，不是浮在脸前面的一层雾。
 *
 *   multiply  压暗底色。腮红、纹身、脸彩这类「长在皮肤上」的
 *   screen    提亮底色，保留底下的明暗。眼泪、水光
 *   add       发光。星星、光斑
 */
export type ElementBlend = "normal" | "add" | "screen" | "multiply";

export type ElementAsset =
  /** 素材库贴纸，key 来自 svg-assets.ts */
  | { kind: "svg-lib"; key: string }
  /** LLM 现写的内联 SVG，注册时过 sanitize，拒收不清洗 */
  | { kind: "svg-inline"; svg: string }
  | { kind: "text"; text: string; fontWeight?: number; color?: string; shadow?: string }
  /** 程序化径向渐变椭圆，腮红这类不值得做成素材的东西 */
  | { kind: "gradient"; shape: "ellipse"; color: string; opacity?: number };

export type ElementAnchor =
  | { space: "screen"; nx: number; ny: number }
  /** landmark 只写语义名。数字是 v1 兼容层的产物，新 JSON 会被校验拒收。 */
  | {
      space: "face";
      landmark: string | number;
      /** 相对锚点的偏移，单位是 IOD（不是像素，也不是 size.ref） */
      offset?: [number, number];
      /** 水平翻转，mirrorPair 展开右侧时自动带上 */
      mirror?: boolean;
    };

export interface ElementV2 {
  id: string;
  asset: ElementAsset;
  anchor: ElementAnchor;
  /** fit 缺省时：text 按 font，其余按 width */
  size: { ref: SizeRef; scale: number; fit?: SizeFit };
  /** 与背后画面的混合方式。缺省 normal，行为与没有这个字段时完全一致 */
  blend?: ElementBlend;
  /** 度。正数顺时针 */
  rotation?: number;
  /** 是否跟随头部 roll。face 空间默认 true，screen 空间恒 false */
  followRoll?: boolean;
  opacity?: number;
  animations?: import("./animations").AnimationV2[];
  /**
   * 让用户自己拖位置 / 滚轮缩放。只对 screen 空间有意义——
   * face 空间的元素位置由 landmark 决定，用户拖了下一帧就被拉回去。
   *
   * 调整量存在渲染器里，不写回 JSON：模板是作者定的初始摆位，
   * 用户的临时调整不该污染它。切模板即重置。
   */
  interactive?: { drag?: boolean; resize?: boolean };
}

/** 帧效果：蒙版来源 × 效果种类 × 作用区域。三者正交，一次引擎活换一批模板。 */
export type MaskProvider = "person" | "face-ellipse" | "none";

export interface SourceEffect {
  mask: {
    provider: MaskProvider;
    /** face-ellipse 专用，本轮未实现 */
    padding?: number;
    /** 边缘羽化宽度，归一化 */
    feather?: number;
    falloff?: number;
    /** 丢失目标时的策略。clear = 全画面恢复原样 */
    onLost?: "clear" | "hold" | "full";
  };
  apply: "inside" | "outside";
  effect:
    | { kind: "pixelate"; blocks: number }
    | { kind: "blur"; radius: number }
    | { kind: "posterize"; levels: number }
    | { kind: "pixel-art"; blocks: number; levels: number; palette?: string; dither?: "none" | "bayer4" };
}

/** 完整配置，只有服务端确认权益后才下发。 */
export interface TemplateConfig extends TemplateListing {
  templateType?: TemplateType;
  perception: Perception[];
  /** particle 类型必填 */
  emitter?: Emitter;
  substance?: Substance;
  controls: Control[];
  /**
   * overlay / facetrack 的元素列表。已由 loadTemplate 阶段完成
   * v1→v2 转换和生成器展开，引擎拿到的永远是平铺的 ElementV2。
   */
  elements?: ElementV2[];
  /** 帧效果（背景马赛克等） */
  source?: SourceEffect;
}

export type ControlValues = Record<string, number>;
