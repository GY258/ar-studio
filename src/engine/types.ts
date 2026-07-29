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
  /**
   * 圆点的混合方式。缺省 normal。
   *
   * 和 settle 解耦是刻意的：以前混合方式是从 settle 推出来的（会堆积 → 加法），
   * 于是「会堆积但要发光」和「会堆积但别发光」表达不出来。
   * add 只给真正在发光的东西（金粉、火星），白色的雪用 add 会在浅色背景上消失。
   */
  blend?: "normal" | "add";
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
  /**
   * 不进模板库列表，但 /studio/<slug> 仍然能直接访问。
   *
   * 给调试工具和还没做完的模板用。**不是权限**：配置照常下发，
   * 知道 slug 的人就能用，别拿它当付费墙 —— 那是 priceCents + 权益表的事。
   */
  hidden?: boolean;
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
    /**
     * 从蒙版里挖掉一块。目前只有 "face" —— 用人脸 landmark 的包围椭圆保护脸部。
     *
     * 放在 mask 上而不是某个 effect 的参数里：mask 管「作用在哪」、
     * effect 管「作用成什么样」，两个轴本来就是正交的。放这儿的话
     * blur / pixelate / desaturate 全都白捡这个能力。
     *
     * 需要 perception 里有 "face"，校验器会拦。
     */
    exclude?: "face";
    /** exclude 椭圆的缩放，1 = 刚好包住 478 个 landmark（只覆盖皮肤，不含头发） */
    excludePadding?: number;
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
    /** radius 是长边的比例，0.01 ≈ 长边的 1% */
    | { kind: "blur"; radius: number }
    /** amount 0~1，1 = 全灰。apply:"outside" 就是「只有我是彩色的」 */
    | { kind: "desaturate"; amount: number }
    /**
     * 数字信号损坏。四种损坏叠在一起才像，所以是一个 kind 带四个强度，
     * 不是四个 kind —— 而且 source.effect 是单个对象，拆开还得先把它改成数组。
     *
     * 注意这不是 datamosh。真 datamosh 是时间域的（丢 I 帧 + 复用运动矢量），
     * 需要跨帧历史，而 renderAt(t) 是无历史的。这里是逐帧程序化损坏：
     * 静态几乎一样，快速运动时不会有「融化」的拖影。
     */
    | {
        kind: "glitch";
        /** 错位块的粒度，短边分几行 */
        blocks: number;
        /** 横向错位强度，画面宽度的比例 */
        displace: number;
        /** RGB 通道分离量，画面宽度的比例 */
        channelSplit: number;
        /** 扫描线强度 0~1 */
        scanline: number;
        /** 色块乱码密度 0~1 */
        colorNoise: number;
        /**
         * 噪声往暗部集中的程度 0~1。
         * 参考素材里乱码几乎全在头发和深色衣服上，浅色皮肤是干净的 ——
         * 不按亮度加权的话脸上也会花，立刻变成廉价滤镜。
         */
        darkBias: number;
        /** 每秒变几次。损坏是离散跳变的，不是连续飘 */
        speed: number;
        /** 必填。噪声必须是 hash(块, 帧号, seed) 的纯函数，不能用随机数 */
        seed: number;
      }
    /** 调试视图：直接把蒙版画出来，不做效果。红 = 判为人，绿 = 过渡带 */
    | { kind: "mask-debug" }
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
