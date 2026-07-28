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

/** 叠加元素：SVG 贴纸或文字，固定在画面上 */
export interface OverlayElement {
  id: string;
  type: "svg" | "text";
  /** SVG asset key（引用 svg-assets.ts 里的 ID） */
  svgAsset?: string;
  /** 文字内容 */
  text?: string;
  /** 归一化坐标，原点左上，(0,0)~(1,1) */
  nx: number;
  ny: number;
  /** 元素宽度，%W（0~1） */
  sizeW: number;
  /** 高宽比（高/宽），用于 SVG */
  aspect?: number;
  /** 旋转角度，度 */
  rotation?: number;
  /** 文字颜色 */
  color?: string;
  /** 文字字号 %W */
  fontSizeW?: number;
  /** 文字字重 */
  fontWeight?: number;
  /** CSS text-shadow */
  shadow?: string;
  /** 浮动动画 */
  float?: { amplitude: number; period: number };
  /** 下落动画：period 秒从顶到底循环，phase 0~1 错开起始位置 */
  fall?: { period: number; phase: number };
}

/** 人脸追踪配置 */
export interface FaceTrackElement {
  id: string;
  type: "tear-pool" | "trailing-tear" | "blush" | "text" | "sticker";
  /** 锚定的 landmark：语义名（推荐）或数字索引（兼容旧 JSON） */
  landmark?: string | number;
  /** SVG asset key */
  svgAsset?: string;
  /** 大小相对 IOD 的比例 */
  iodScale?: number;
  /** 是否水平翻转（右眼） */
  mirror?: boolean;
  /** 文字内容 */
  text?: string;
  /** 固定屏幕位置（不跟踪人脸时） */
  nx?: number;
  ny?: number;
  /** sticker 相对锚点的偏移，单位 IOD */
  offsetX?: number;
  offsetY?: number;
  /** SVG 高宽比 */
  aspect?: number;
  /** 旋转角度 */
  rotation?: number;
  /** 文字字号 %W */
  fontSizeW?: number;
  fontWeight?: number;
  color?: string;
  shadow?: string;
  /** 浮动动画 */
  float?: { amplitude: number; period: number };
}

export interface FaceTrackAnimation {
  breathe: { scaleRange: [number, number]; period: number };
  tears: { count: number; distance: number; period: number; phaseShift: number };
}

/** 完整配置，只有服务端确认权益后才下发。 */
export interface TemplateConfig extends TemplateListing {
  templateType?: TemplateType;
  perception: Perception[];
  /** particle 类型必填 */
  emitter?: Emitter;
  substance?: Substance;
  controls: Control[];
  /** overlay 类型的元素列表 */
  overlayElements?: OverlayElement[];
  /** facetrack 类型的元素列表 */
  faceTrackElements?: FaceTrackElement[];
  faceTrackAnimation?: FaceTrackAnimation;
}

export type ControlValues = Record<string, number>;
