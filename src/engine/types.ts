/**
 * 模板 schema（PRD 5.3）。
 *
 * 引擎只认这里的类型，不认具体模板。加「莲蓬头」和加「咖啡杯」对代码是同一件事。
 * 新创意超出表达能力时，扩展这个 schema，而不是在引擎里写 if (slug === "...")。
 */

export type LocalizedText = { zh: string; en?: string };

/** 物质：决定粒子怎么动、怎么撞、怎么画。雪和水不是换颜色，是两套参数。 */
export interface Substance {
  /** 重力加速度，px/s²，负值向下。雪 -560，水 -1750。 */
  gravity: number;
  /** 碰撞摩擦，0~1。撞上人体后切向速度衰减这么多。雪 0.45 会堆住，水 0.05 会滑走。 */
  friction: number;
  /** 拉伸系数，秒。粒子沿速度方向拉长 speed*streak 像素。0 = 圆点（雪），>0 = 液体。 */
  streak: number;
  /** 线性色，0~1。液体的高光核由引擎另加。 */
  color: [number, number, number];
  /** 半径范围（世界像素）。液体是胶囊半径，雪是圆点半径。 */
  size: [number, number];
  /** 初速范围，px/s。 */
  speed: [number, number];
  /** 出射角散布，弧度。花洒要宽（0.2），细水流要窄（0.12）。 */
  spread: number;
  /** 撞击后溅几滴。0 = 不溅（雪）。 */
  splash: number;
  /** 撞上后是否停留堆积。true 走加法混合 + 短暂驻留，false 直接顺着流走。 */
  settle: boolean;
  /** 是否闪烁。雪的颗粒感来源，液体不要。 */
  twinkle: boolean;
}

/** 发射器（道具）。asset 缺省时用内置的程序化贴图，零外部素材也能跑。 */
export interface Emitter {
  /** 贴图 URL。留空则按 shape 现画。 */
  asset?: string;
  /** 内置程序化道具。asset 存在时忽略。 */
  shape?: "cloud" | "shower" | "glass" | "cup";
  /** 高宽比 = 高 / 宽。 */
  aspect: number;
  /** 出口相对道具中心的位置，单位是道具自身的宽 / 高。y 向下为正。 */
  port: { x: number; y: number };
  /** 出口横向铺开宽度，单位是道具宽度。花洒要铺满喷头面，细水流接近 0。 */
  band: number;
  /** 初速偏离垂直方向的角度，弧度，正 = 向右。倾倒类道具需要。 */
  tilt?: number;
  draggable: boolean;
  /** 初始位置，归一化屏幕坐标，(0,0) 是画面中心，y 向上为正。 */
  default: { x: number; y: number };
}

/** 物质里可以被滑块调的数值字段。tuple 字段按两端一起缩放处理。 */
export type SubstanceKnob =
  | "gravity"
  | "friction"
  | "streak"
  | "size"
  | "speed"
  | "spread"
  | "splash";

/**
 * 滑块作用的对象。
 *  - rate / wind / stick 是引擎内置语义（发射速率、横向风、黏附强度）
 *  - substance.<字段> 直接调物质参数
 */
export type ControlTarget = "rate" | "wind" | "stick" | `substance.${SubstanceKnob}`;

/**
 * 工作台暴露给用户的滑块。每个模板 2~4 个，由配置定义，不硬编码。
 *
 * key 是任意字符串，不再是固定三个——否则新模板想暴露「颗粒大小」这种参数
 * 就得改引擎，模板系统的可扩展性会卡死在这里。
 */
export interface Control {
  key: string;
  label: LocalizedText;
  min: number;
  max: number;
  default: number;
  step?: number;
  /** 省略时按 key 走内置语义（key 得正好是 rate / wind / stick 之一）。 */
  target?: ControlTarget;
  /**
   * absolute 直接赋值；scale 把滑块值当百分比乘到模板基准值上（100 = 原值）。
   * tuple 字段（size / speed）用 scale 时两端一起缩放，用 absolute 时两端都设成这个值。
   */
  mode?: "absolute" | "scale";
}

/** 需要哪些感知模型，决定加载什么。首期只有分割。 */
export type Perception = "segmentation" | "face" | "hands";

/** 付费模板未解锁时，服务端只下发这部分（PRD 5.5）。 */
export interface TemplateListing {
  slug: string;
  name: LocalizedText;
  category: string;
  priceCents: number;
  preview: { poster?: string; video?: string; shape?: Emitter["shape"] };
  locked: boolean;
}

/** 完整配置，只有服务端确认权益后才下发。 */
export interface TemplateConfig extends TemplateListing {
  perception: Perception[];
  emitter: Emitter;
  substance: Substance;
  controls: Control[];
}

/** 用户当前调好的参数值，按 control.key 索引。 */
export type ControlValues = Record<string, number>;
