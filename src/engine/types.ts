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

/**
 * 滑块绑到哪。
 *
 * `element.<元素 id>.<参数名>` 让 overlay / facetrack 模板的元素参数也能上滑块 ——
 * 在这之前 `controls` 对非 particle 模板是**静默失效**的：写了能过校验、
 * 面板上也会画出滑块，拖了什么都不发生，而且不报错。
 * 能挂的参数名见 engine/tunables.ts。
 */
export type ControlTarget = "rate" | "wind" | "stick" | `substance.${SubstanceKnob}` | `element.${string}.${string}`;

export interface Control {
  key: string;
  label: LocalizedText;
  min: number;
  max: number;
  default: number;
  step?: number;
  target?: ControlTarget;
  mode?: "absolute" | "scale";
  /**
   * 离散档位。给了就渲染成一排按钮而不是滑块。
   *
   * 「强度四档」这种诉求用连续滑块表达不了 —— 用户要的是「选一个预设」，
   * 不是「在 0~100 之间找一个数」。min/max/default 仍然要写，
   * default 必须是某一档的 value。
   */
  options?: { label: LocalizedText; value: number }[];
}

export type Perception = "segmentation" | "face" | "hands" | "pose";

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

export type AnchorSpace = "screen" | "face" | "hand";

/**
 * 尺寸参照物。face_width / eye_width / palm_width 由 landmark 实测，
 * 人退远会一起缩小；vw 不会。
 */
export type SizeRef = "vw" | "iod" | "eye_width" | "face_width" | "palm_width";

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
  | { kind: "gradient"; shape: "ellipse"; color: string; opacity?: number }
  /**
   * 轨迹：锚点走过的路，画成一条带。
   *
   * **这是第一个几何形状依赖时间历史的 asset。** 别的 asset 都是
   * f(当前帧) 的纯函数，它是 f(这一段时间里锚点去过哪)。所以它要求
   * 离线渲染走 stepTo(t) 逐步积过去，不能像别的模板那样直接跳到任意 t。
   *
   * size.scale 量的是带的宽度（相对 size.ref）。
   */
  | {
      kind: "trail";
      color: string;
      /** 保留多久的历史，秒。也就是这条带有多长 */
      seconds: number;
      /** 沿途长叶子。位置由 hash(第几片, seed) 定，纯函数，不额外占状态 */
      leaf?: {
        /** svg-lib 的 key */
        key: string;
        /** 相邻两片的间距，单位是 size.ref */
        spacing: number;
        /** 叶子大小，相对 size.ref */
        scale: number;
        /** 必填。没有 seed 每次展开长的位置都不一样，golden 对比不成立 */
        seed: number;
      };
    }
  /**
   * 茎：从画面底边长到指尖，长度由**这根手指的弯曲度**决定。弯多少长多少。
   *
   * 和 trail 是两种机制，别混。trail 画的是「锚点走过的路」，需要跨帧历史；
   * 茎画的是「底边到指尖的一条曲线，截取前 curl 段」——
   * **完全是当前帧的纯函数**，不占状态、不需要 stepTo。
   *
   * 这也是它比 trail 好的地方：轨迹要求你挥手才有东西看，而且手一停就开始淡出；
   * 茎是直接操控 —— 弯回去它就缩回去，反复弯就反复长，反馈是即时的。
   *
   * size.scale 量的是茎的宽度（相对 size.ref）。
   */
  | {
      kind: "stem";
      color: string;
      /** 哪根手指的弯曲度驱动它。一般和 anchor 的指尖对应，但不强制 */
      finger: "thumb" | "index" | "middle" | "ring" | "pinky";
      /**
       * 茎的弯曲程度，占画面宽度的比例。0 = 笔直的竖线。
       *
       * 给一点弯是必要的：十根笔直的竖线读起来像条形码，不像植物。
       * 实际方向由 seed 决定，左右手不会一起往同一边倒。
       */
      bow?: number;
      /** 底边到指尖采多少个点。少了曲线会有折角，多了纯浪费 */
      segments?: number;
      /** 沿途长叶子。位置由弧长和 hash(第几片, seed) 定，纯函数 */
      leaf?: { key: string; spacing: number; scale: number; seed: number };
      /** 长在茎顶端的花，跟着生长的那一头走。不写就只有一根光茎 */
      flower?: { key: string; scale: number };
      /** 必填。决定弯的方向和叶子的左右，没它同一个模板每次加载都不一样 */
      seed: number;
    }
  /**
   * Fluidity：带编号的检测框 + 互相连接的细线，跟着人体运动实时抖动重组。
   *
   * anchor 写 screen（满屏的效果，不挂在某一个点上），元素自己的 size 会被忽略 ——
   * 框的大小由 asset.boxScale 相对**肩宽**决定，人退远会一起缩。
   *
   * 需要 perception: ["pose"]。密度由**姿态**驱动（双腕间距 / 肩宽）而不是运动速度，
   * 所以它仍然是当前帧的纯函数，见 fluidity.ts 的文件头。
   */
  | {
      kind: "fluidity";
      /** 最多几个框 */
      boxes: number;
      /** 最多几条线 */
      lines: number;
      /** 每秒重检测几次。编号跳变和抖动的节奏，不做插值 */
      detectHz: number;
      /** 框位置抖动幅度，相对肩宽 */
      jitter: number;
      /**
       * 框的**平均**大小，相对肩宽。
       *
       * 给平均值而不是 min/max：分布是偏小的幂次，min/max 那套**算不出平均值**，
       * 想「把框调小一点」得先在脑子里做一遍积分。
       */
      boxSize: number;
      /**
       * 大小差异程度 0~1。0 = 全一样大；1 = 大量小框 + 少数几个大框（参考的样子）。
       * 不管调多少，**平均值恒等于 boxSize**。
       */
      boxSizeSpread: number;
      /** 多少比例的框带编号 0~1。参考素材里不是每个框都有 */
      labelRatio: number;
      /**
       * 静止时还剩多少密度 0~1。
       * 参考素材里手收拢那几帧只剩三五个框，给小一点才有那个对比。
       */
      density: number;
      /** 多少比例的线拉出画面 0~1。给大了满屏横贯的斜线会盖掉人体上的网 */
      lineReach: number;
      /**
       * 多少比例的**小**框是实心的 0~1。
       * 全描边的话画面太均质，实心的那几个是节奏上的重音。
       * 只作用在小于平均大小的框上 —— 大框填实会糊掉半个身子。
       */
      fillRatio: number;
      /** 编号位数。参考素材是 5 位 */
      digits: number;
      color: string;
      /** 必填。编号和抖动都是 hash(第几个, 第几个检测帧, seed) 的纯函数 */
      seed: number;
    }
  /**
   * 肥皂泡：一开场就满屏浮着，指尖划过去戳破。破了不再生，所以能清空。
   *
   * anchor 写 screen（它是满屏的模拟，不挂在任何一个点上），size 会被忽略 ——
   * 泡泡的大小由 asset.size 这个区间决定，因为一屏里本来就要有大有小。
   *
   * 位置是时刻的**闭式函数**（见 bubbles.ts 的文件头），所以真正可变的状态
   * 只有「破没破」一个单调位。这让它和轨迹是同一个量级的复杂度，
   * 而不是原先 ROADMAP 里担心的「一池互相影响的对象」。
   */
  | {
      kind: "bubbles";
      /** 同时最多几个 */
      count: number;
      /** 上升速度，每秒走过画面高度的比例 */
      rise: number;
      /** 半径范围 [最小, 最大]，占画面宽度的比例 */
      size: [number, number];
      /** 横向摆动幅度，占画面宽度的比例 */
      wobble: number;
      /** 戳破判定半径，相对泡泡半径的倍数。>1 是因为指尖 landmark 本身有抖动 */
      popRadius: number;
      /** 折射强度：把背后的画面推开多少，相对自身半径 */
      refraction: number;
      /** 边缘薄膜干涉的彩虹强度 0~1 */
      iridescence: number;
      /** 必填。冒泡的位置、大小、速度都是 hash(第几个, seed) 的纯函数 */
      seed: number;
    }
  /**
   * 捏合绽放：拇指和食指捏在一起时，在捏合点冒出一朵，然后放大淡出。
   *
   * 和 trail 一样依赖跨帧状态（要知道「刚捏上」而不是「正捏着」），
   * 所以同样要求离线渲染走 stepTo。锚点只需要 space "hand" + hand，
   * 位置由拇指尖和食指尖的中点算，写哪个 landmark 都不影响结果。
   */
  | {
      kind: "pinch-bloom";
      /** svg-lib 的 key。开出来的是什么花 */
      key: string;
      /** 一朵活多久，秒 */
      seconds: number;
      /** 最终大小相对 size.ref 的倍数 */
      grow: number;
    };

export type ElementAnchor =
  | { space: "screen"; nx: number; ny: number }
  /**
   * 手部锚点。hand 说的是**本人的**左右手，不是画面上的左右 ——
   * 画面是镜像的，本人的左手出现在屏幕右侧。按「戴戒指的那只手」思考。
   *
   * 一个元素绑一只手的一个点。要「十根指尖各挂一个」就写十个元素；
   * 这比引入一个「按手展开」的隐式复制要好，因为每根手指挂的东西通常不一样。
   */
  | {
      space: "hand";
      hand: "left" | "right";
      /** 只写语义名，见 hand-anchors.ts */
      landmark: string;
      /** 相对锚点的偏移，单位是掌宽 */
      offset?: [number, number];
    }
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
    /**
     * 体素化：把画面重建成 Minecraft 那样的方块世界。
     *
     * 块色来自**当前帧的真实像素**，不是贴一张事先做好的场景图 ——
     * 所以构图和光照是按构造就匹配的。配 mask.provider "person" + apply "outside"
     * 就是「人完全不动，只有背景变方块」。
     *
     * 和 pixelate 的区别不在网格：只做网格得到的是马赛克（画面糊了），
     * 方块世界还需要调色板、立方体的面、块间接缝这三样，见 source-effects.ts。
     */
    | {
        kind: "voxel";
        /** 短边分几格。和 pixelate 同一个轴，resize 时块保持正方形 */
        blocks: number;
        /**
         * 往 Minecraft 方块色靠拢的强度 0~1。
         *
         * 吸附时**保住原块的亮度**（见 shader 里的注释），所以调到 1
         * 也不会把光照拍平 —— 颜色是 MC 的，明暗还是这一帧的。
         */
        palette: number;
        /** 每通道量化到几级。MC 的贴图色阶很平，连续渐变一眼就不像 */
        levels: number;
        /** 量化前先提多少饱和度。真实房间偏灰，不提的话得到一堆灰方块 */
        saturate?: number;
        /** 立方体的面：顶边提亮 / 底边压暗的强度 0~1 */
        faceShade: number;
        /** 块间接缝压暗多少 0~1。方块要能一个个数出来 */
        outline: number;
        /** 块内颗粒 0~1。MC 的 16×16 贴图本来就有噪点，纯平色像 UI */
        grain?: number;
        /**
         * 用多大范围的颜色去填一个块 0~1，缺省 0.65。
         *
         * **和 blocks 是两个独立的选择**，别绑在一起：块小是为了保住细节，
         * 平滑是为了让相邻块落到同一个调色板项上（连续的色块区域靠这个）。
         * 我一开始绑在一起了 —— 为了压椒盐点把块调大，结果背景什么都认不出来。
         *
         * 0 = 每块只看自己（细节最多，也最容易椒盐）
         * 1 = 完全用 3×3 邻域（最连贯，也最糊）
         */
        smooth?: number;
        /**
         * 暗部地板 0~1，缺省 0.02。
         *
         * ⚠️ 是**线性空间**的值，别按 sRGB 的直觉取：sRGB 的 64 在线性里只有 0.05，
         * 给 0.12 等于把它抬了三倍多，整张背景发白发灰（饱和度会掉一半以上）。
         *
         * 存在的理由：MC 的世界里没有纯黑（天光是全局的），而亮度量化会把
         * 最暗的一档直接归零。给一点点地板就够，不需要整体提亮。
         */
        ambient?: number;
        /** 必填。颗粒是 hash(块坐标, seed) 的纯函数，不能用随机数 */
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
