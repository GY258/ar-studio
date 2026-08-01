/**
 * 模板知识的**唯一**来源。
 *
 * 有两个地方消费同一份知识：
 *   - 开发期在仓库里写模板  → .claude/skills/ar-template/reference/（由 gen-skill-reference 生成）
 *   - 运行期用户描述生成    → /api/generate 的 system prompt
 *
 * 两边必须共用这一个文件，否则半年后就是两套互相矛盾的说明书。
 * 这里的内容全部从 anchors.ts / svg-assets.ts / 模板目录读出来，不手写常量——
 * 手写的那一刻就开始漂移了。
 */

import { FACE_ANCHORS, ANCHOR_PAIRS } from "@/engine/anchors";
import { HAND_ANCHORS } from "@/engine/hand-anchors";
import { listSvgKeys, getSvg } from "@/engine/svg-assets";
import { extractAspect } from "@/engine/svg-sanitize";

/** ElementV2 / AnimationV2 / GeneratorV2 / SourceEffect 的类型说明。 */
export function buildSchemaReference(): string {
  const anchorNames = Object.keys(FACE_ANCHORS);
  const handAnchorNames = Object.keys(HAND_ANCHORS);

  return `## 模板骨架

\`\`\`jsonc
{
  "slug": "kebab-case",                 // 小写字母 / 数字 / 连字符
  "name": { "zh": "中文名", "en": "English" },
  "category": "face | sticker | fun | ...",
  "sort_order": 60,                     // 列表排序，小的在前
  "price_cents": 0,
  "hidden": false,                      // 可选。true = 不进模板库列表，但 /studio/<slug> 仍可直接访问
  "schema_version": 2,
  "template_type": "facetrack | overlay",
  "perception": ["face"],               // segmentation / face / hands，用到什么写什么
  "preview": {},
  "elements": [ /* ElementV2 或生成器 */ ],
  "source": { /* 可选，帧效果 */ }
}
\`\`\`

\`template_type\` 只影响默认的 perception，元素本身不分类型——
一个模板里同时有跟脸的元素和固定在屏幕上的元素是合法的。

## ElementV2

三个维度彼此正交，不要互相耦合：

\`\`\`ts
interface ElementV2 {
  id: string;                 // 模板内唯一
  asset: ElementAsset;        // 画什么
  anchor: ElementAnchor;      // 画在哪
  size: { ref: SizeRef; scale: number; fit?: SizeFit };  // 画多大，scale ∈ (0, 3]
  rotation?: number;          // 度
  followRoll?: boolean;       // 是否跟头部滚转。face 空间默认 true
  opacity?: number;           // [0, 1]
  blend?: "normal" | "add" | "screen" | "multiply";    // 与背后画面的混合，缺省 normal
  animations?: AnimationV2[];
  interactive?: { drag?: boolean; resize?: boolean };  // 让用户自己拖/缩，仅 screen 空间
}

type ElementAsset =
  | { kind: "svg-lib";    key: string }        // 素材库贴纸，key 见素材清单
  | { kind: "svg-inline"; svg: string }        // 现写的 SVG，必须带 viewBox
  | { kind: "text";       text: string; color?: string; fontWeight?: number; shadow?: string }
  | { kind: "gradient";   shape: "ellipse"; color: string; opacity?: number }
  | { kind: "trail";      color: string; seconds: number;   // 锚点走过的路，画成一条带
      leaf?: { key: string; spacing: number; scale: number; seed: number } }
  | { kind: "stem";       color: string;                    // 从画面底边长到指尖的一根茎
      finger: "thumb" | "index" | "middle" | "ring" | "pinky";  // 哪根手指的弯曲度驱动它
      bow?: number;                                         // 弯曲程度，占画面宽度；0 = 笔直
      segments?: number;                                    // 采样点数，默认 24
      leaf?: { key: string; spacing: number; scale: number; seed: number };
      flower?: { key: string; scale: number };              // 长在茎顶端，跟着生长的那头走
      seed: number }                                        // 必填：定弯的方向和叶子的左右
  | { kind: "bubbles";    count: number; rise: number;       // 肥皂泡，见下
      size: [number, number]; wobble: number; popRadius: number;
      refraction: number; iridescence: number; seed: number }
  | { kind: "pinch-bloom"; key: string; seconds: number; grow: number }  // 捏合时开一朵

type ElementAnchor =
  | { space: "screen"; nx: number; ny: number }   // 归一化屏幕坐标，[-0.2, 1.2]
  | { space: "face";   landmark: FaceAnchorName;  // 只写语义名，绝不写数字
      offset?: [number, number];                  // 单位 IOD（瞳距），y 正数向下
      mirror?: boolean }                          // 水平翻转
  | { space: "hand";   hand: "left" | "right";    // **本人的**左右手，见下
      landmark: HandAnchorName;
      offset?: [number, number] }                 // 单位掌宽，y 正数向下

type SizeRef = "vw" | "iod" | "eye_width" | "face_width" | "palm_width"
type SizeFit = "width" | "font"
\`\`\`

**\`size.ref\` 与 \`anchor.space\` 正交。** \`space: "face"\` + \`ref: "vw"\` 是合法且常用的
组合，含义是「跟着脸平移，但按屏幕定大小」，人退远时不会跟着缩小。反过来
\`space: "screen"\` + \`ref: "iod"\` 也合法。别因为锚在脸上就默认尺寸得用 iod。

**\`size.fit\` 决定 scale 在量什么。** \`width\` = 元素画出来有多宽，高度按素材比例推；
\`font\` = 字号有多大，宽度由内容长度决定。缺省时 text 走 \`font\`，其余走 \`width\`。
「这行字占屏幕 1/3 宽」和「这行字 28px 高」是两个诉求，猜哪个都会猜错，所以显式写。
svg 和 gradient 只有宽度一种含义，写 \`fit: "font"\` 也按宽度处理。

高度一律按 viewBox 的高宽比自动算——不要手填 aspect，这个字段已经没有了。

**\`blend\` 决定元素怎么和背后的画面融。** 缺省 \`normal\` 是一块不透明的色块糊在脸上，
真实的眼泪是折射的，颜色主要来自它背后的皮肤：

- \`multiply\` 压暗底色 → 腮红、纹身、脸彩这类「长在皮肤上」的
- \`screen\` 提亮但保留底下的明暗 → 眼泪、水光
- \`add\` 发光 → 星星、光斑

贴在脸上的半透明东西默认就该考虑 \`multiply\` 或 \`screen\`，别一律用 normal。

### trail vs stem —— 先分清要哪个

两个都画成一条带，但**驱动它的东西完全不同**，选错了做出来不是那个效果：

| | trail | stem |
|---|---|---|
| 画的是 | 锚点走过的路 | 画面底边到指尖的一条曲线 |
| 长度由什么定 | 过去 \`seconds\` 秒走了多远 | **这根手指弯了多少** |
| 用户要做什么 | 挥动，停下就开始淡出 | 弯一下手指，弯多少长多少 |
| 状态 | 跨帧历史，离线渲染必须走 \`stepTo\` | 当前帧的纯函数，跳到任意 t 都对 |

「弯一下手指从底部长一根花出来」是 **stem**。用 trail 做的话得一直挥手，
手一停花就开始消失 —— 完全是另一个交互。

### stem —— 弯手指长出来

\`\`\`jsonc
{ "id": "stem-l-index",
  "asset": { "kind": "stem", "color": "#4FAE52", "finger": "index",
             "bow": 0.05, "segments": 26, "seed": 107,
             "leaf":   { "key": "emoji-leaf", "spacing": 0.85, "scale": 0.3, "seed": 11 },
             "flower": { "key": "emoji-sunflower", "scale": 0.62 } },
  "anchor": { "space": "hand", "hand": "left", "landmark": "index_tip" },
  "size": { "ref": "palm_width", "scale": 0.055 } }   // scale 是茎的宽度
\`\`\`

- \`finger\` 必填，是**驱动**这根茎的手指。一般和 anchor 的指尖对应，
  但不强制 —— 不写茎永远不会长，所以校验器会拦
- 必须锚在 \`space: "hand"\`。别的空间没有手指
- 伸直时读到的弯曲度在 0.06 以下整根不画，免得指尖下面挂一小截毛刺
- \`flower\` 长在**生长的那一头**，茎没长出来时它也不显示 ——
  所以不用再单独写一个指尖贴纸元素，写了反而会在茎没长时孤零零挂着
- \`bow\` 给一点弯是必要的：十根笔直的竖线读起来像条形码，不像植物。
  方向由 \`seed\` 定，不由左右手定 —— 按左右手分会镜像般一起倒，像装饰边框

### trail —— 锚点走过的路

\`\`\`jsonc
{ "id": "sparkle-tail",
  "asset": { "kind": "trail", "color": "#FFD54F", "seconds": 2.6,
             "leaf": { "key": "emoji-leaf", "spacing": 0.75, "scale": 0.24, "seed": 11 } },
  "anchor": { "space": "hand", "hand": "left", "landmark": "index_tip" },
  "size": { "ref": "palm_width", "scale": 0.035 } }   // scale 是带的宽度
\`\`\`

**几何形状依赖时间历史。** 别的 asset 都是「当前帧」的纯函数，
它是「这一段时间里锚点去过哪」。所以：

- 必须锚在**会动**的东西上（\`space\` 是 \`hand\` 或 \`face\`）。锚在 screen 上是
  一个固定点，没有轨迹，校验器会拦
- \`seconds\` 既是保留多久的历史，也就是这条带有多长
- \`leaf.seed\` 必填。叶子的位置和大小是 \`hash(第几片, seed)\` 的纯函数，
  不占额外状态，但没有 seed 每次长的地方都不一样，golden 对比不成立

采样落在固定的 12Hz 时间网格上，不是每帧一次 —— 每帧一次的话同一段手势在
60fps 和 20fps 下会生成不同的带。相邻采样点位移超过 0.18 屏会**断开重新起一条**：
手划出画面再进来、检测短暂丢失重新锁定，都会瞬移，连起来就是一条横跨画面的假线。

### bubbles —— 肥皂泡，指尖戳破

\`\`\`jsonc
{ "id": "bubbles",
  "asset": { "kind": "bubbles", "count": 30, "rise": 0.05,
             "size": [0.028, 0.085], "wobble": 0.02, "popRadius": 1.15,
             "refraction": 0.34, "iridescence": 0.9, "seed": 23 },
  "anchor": { "space": "screen", "nx": 0.5, "ny": 0.5 },
  "size": { "ref": "vw", "scale": 1 } }
\`\`\`

一开场就满屏浮着，**十根指尖**（两只手）划过去都能戳破。泡泡纵向**绕回**
（飘出顶端就从底端接着进来），所以没人戳的话一个都不会少。

**破掉的不再生**，所以这个玩具有终局：全部戳完屏幕就空了。
会不停补充的话它只是个屏保，没有「玩完了」这件事。
必须 \`perception: ["hands"]\`，锚点必须是 \`space: "screen"\` ——
它是满屏的模拟，不挂在任何一个点上，元素自己的 \`size\` 会被忽略
（泡泡大小由 \`asset.size\` 这个区间决定，一屏里本来就要有大有小）。

**位置是时刻的闭式函数**，不是逐帧积分：

    y(t) = wrap(y0 + vy * (t - t0))
    x(t) = x0 + sin(t * 0.21Hz + phase) * wobble

所以一个泡泡从生到死只存 \`{ t0, x0, r, vy, phase }\` 这几个不变量，
每帧不修改任何东西 —— 没有「浮点求和顺序敏感」，也不会因为掉帧而漂。
真正可变的只有**破没破**一个单调位。

- \`popRadius\` 是相对泡泡半径的倍数，给 >1 是因为**指尖 landmark 本身有抖动**，
  按几何半径判会经常戳不中，玩起来很挫
- \`refraction\` 直接采源视频纹理，不读回帧缓冲 —— 泡泡背后就是摄像头画面，
  那正是想要的效果
- \`iridescence\` 的彩虹只出现在最外那一圈。铺满整个球会得到一个饱和的彩虹环，
  一眼假：真实肥皂泡的色散集中在掠射角，正面看几乎无色
- 初始位置是**分层**撒的（每个槽位固定一个格子，格内抖动），不是纯随机。
  纯随机撒 30 个点必然结块 —— 一半屏幕空着，另一半挤成一坨
- \`size\` 那个区间别给太大：0.16 的泡泡在 1080p 上是 300px，几个就糊满半屏
- 没做泡泡之间的碰撞。参考素材里它们本来就是互相穿过的，
  做碰撞要放弃闭式位置、回到逐帧积分，把上面那一整段简单性都赔进去

### pinch-bloom —— 捏合绽放

\`\`\`jsonc
{ "id": "bloom-left",
  "asset": { "kind": "pinch-bloom", "key": "emoji-cherry-blossom", "seconds": 1.1, "grow": 0.85 },
  "anchor": { "space": "hand", "hand": "left", "landmark": "index_tip" },
  "size": { "ref": "palm_width", "scale": 1 } }
\`\`\`

拇指和食指捏在一起时，在**两指中点**冒出一朵，然后放大淡出。
锚点必须是 \`space: "hand"\`（捏合要靠拇指尖和食指尖的距离判定）；
写哪个 \`landmark\` 不影响结果，位置永远取两指中点。

**边沿触发，不是状态触发**：一次捏合 = 一朵花。判定带迟滞（0.28 收 / 0.42 放），
不然手在临界点抖一下就是一串。距离除以掌宽再判，否则人退远之后永远算捏合中。

和 trail 一样依赖跨帧状态，所以同样要求离线渲染走 stepTo。

### 手部锚点

\`\`\`jsonc
{ "id": "l-index", "asset": { "kind": "svg-lib", "key": "emoji-sunflower" },
  "anchor": { "space": "hand", "hand": "left", "landmark": "index_tip", "offset": [0, 0.18] },
  "size": { "ref": "palm_width", "scale": 0.4 } }
\`\`\`

**\`hand\` 说的是本人的左右手，不是画面上的左右。** 画面是镜像的，
本人的左手出现在屏幕右侧。按「戴戒指的那只手」思考，别按屏幕位置思考。

**一个元素绑一只手的一个点。** 要「十根指尖各挂一个」就写十个元素 ——
没有「按手自动复制」的生成器，因为每根手指挂的东西通常不一样。

\`offset\` 单位是**掌宽**（食指根到小指根），和人脸那边用 IOD 是一个道理：
用像素的话人一退远偏移就不成比例了。\`size.ref: "palm_width"\` 同理。

**手部元素默认不跟手转**（\`followRoll\` 缺省 false）：emoji 立着好看，
而且手的 roll 抖动比头大得多。要跟就显式写 \`followRoll: true\`。

用了手部锚点或 \`palm_width\` 就**必须** \`perception: ["hands"]\`，校验器会拦 ——
忘了声明的话手部模型不加载，元素永远隐藏，而且不报错。

**\`interactive\`** 让用户在画面上直接拖动元素、滚轮或双指缩放它。
只对 \`space: "screen"\` 有意义——face 空间的位置由 landmark 决定，拖了下一帧就被拉回去。
调整量只存在渲染器里，不写回 JSON，切模板即重置。假 UI 面板、水印这类
「作者给个初始摆位，用户自己挪」的元素适合开这个。

## AnimationV2

多条动画叠加。\`period\` 单位秒，\`phase\` 归一化到一个周期（0~1）。

\`\`\`ts
| { preset: "float";  amplitude: number; period: number; phase?: number }
  // 上下浮动。amplitude 是画面高度的比例，0.01 = 1%H
| { preset: "fall";   period: number; phase?: number; ease?: Ease }
  // 从画面顶飞到画面底并循环。走整屏高度，与锚点的 ny 无关
| { preset: "pulse";  scaleRange: [number, number]; period: number; phase?: number }
| { preset: "spin";   period: number; phase?: number }
| { preset: "emit-fall-fade";
    distance: number;        // 位移距离，单位 IOD
    period: number;
    phase?: number;
    ease?: Ease;
    outwardDrift?: number;   // 默认 0.08，越往下越往外撇
    shrink?: number;         // 默认 0.3
    emitPortion?: number;    // 默认 0.15，冒出来占周期的比例
    fadePortion?: number }   // 默认 0.15

type Ease = "linear" | "in" | "out" | "inout" | "gravity" | "bounce"   // 缺省 linear
\`\`\`

**缺省的 \`linear\` 读起来是「一张贴纸在匀速下滑」。** 水是加速下落的，
眼泪、雨滴这类受重力的东西写 \`ease: "gravity"\`，起步慢、落到下巴快。

\`ease\` 只有 \`fall\` 和 \`emit-fall-fade\` 支持，它们是「0→1 走一趟」的过程。
\`float\` / \`pulse\` / \`spin\` 是周期性的，缓动套在相位上会在每个周期的接缝处
留一个速度拐折（转一圈然后顿一下），所以写了会被校验拒收，不是悄悄不生效。

## 生成器

和平铺元素完全等价，写在 \`elements\` 里，loadTemplate 阶段展开。
生成器覆盖不了的排列（比如摆成心形）直接写平铺列表就行，两者没有优劣。

\`\`\`ts
| { generate: "mirrorPair"; anchor: PairName; offset?: [number, number];
    item: Item; children?: Generator[] }
  // 左右各一个。右侧自动带 mirror: true 并翻转 x 偏移
| { generate: "trail"; count: number; step: number; decay?: number;
    landmark?: FaceAnchorName; direction?: "down" | "down-out";
    phaseShift?: number; item: Item }
  // 一串。step 是 y 间距（IOD），phaseShift 是相邻两个的起始时间差（秒）。
  // 放在顶层必须写 landmark，不写会静默挂到 nose_bridge 上；
  // 嵌在 mirrorPair 里则不用写，父生成器会把左右锚点分别传下来。
  // step: 0 + phaseShift 就是「同一个点错峰连发」（眼泪、吐金币）
| { generate: "columns"; rows: number; sides: "both" | "left" | "right";
    startOffset: [number, number]; stepY: number; driftX?: number;
    labels?: string[]; item: Item }
  // 注意字段名是 startOffset，不是 start
| { generate: "scatter"; count: number; seed: number;
    sizeRange?: [number, number]; edgeBias?: number; item: Item }
  // 屏幕空间满屏撒。count 是标量不是区间。seed 必填
| { generate: "ring"; count: number; radius: number;
    arc?: [number, number]; tangentRotate?: boolean; item: Item }
| { generate: "spread"; count: number; width: number; item: Item }
\`\`\`

\`item\` 是「去掉 id 和 anchor 的 ElementV2」——这两个字段由生成器负责填，写了会被拒收。

### item.jitter：把整齐的一批打散

生成器默认产出一批一模一样的东西。\`trail\` 写 \`step: 0 + decay: 1\` 时三滴眼泪
起点相同、大小相同，只有相位差，于是沿同一条线单列前进，像流水线上的零件。
真实的眼泪大小不一、路径略有偏离、时间不规整。

\`\`\`ts
jitter?: {
  size?: number;              // 尺寸倍率的随机半宽，0.2 = ±20%
  phase?: number;             // 归一化相位的随机偏移
  offset?: [number, number];  // 位置的随机偏移，单位 IOD
  seed: number;               // 必填，理由同 scatter
}
\`\`\`

支持 \`mirrorPair\` / \`trail\` / \`ring\` / \`spread\`。\`columns\` 是版式（标签逐个对齐），
抖了就歪，写了会被拒收；\`scatter\` 本来就是随机的，用它自己的 seed / sizeRange。

## 成对锚点（mirrorPair 的 anchor）

${Object.entries(ANCHOR_PAIRS)
  .map(([k, v]) => `- \`${k}\` → ${v[0]} / ${v[1]}`)
  .join("\n")}

写 \`lower_eyelid\`，不是 \`lower_eyelid_left\`。

## 帧效果 source

和 \`elements\` 平级。元素是「画在上面的东西」，source 是「源视频怎么被画出来」，两回事。

\`\`\`ts
{
  mask: { provider: "person" | "none";     // face-ellipse 留了枚举没实现
          exclude?: "face";                // 从蒙版里挖掉脸，见下
          excludePadding?: number;         // [0.5, 2]，缺省 1
          feather?: number;                // [0, 0.1]
          onLost?: "clear" | "hold" | "full" },
  apply: "inside" | "outside",             // 效果作用在人身上 / 背景上
  effect: { kind: "pixelate";   blocks: number }   // blocks ∈ [4, 200]，短边格数
        | { kind: "blur";       radius: number }   // [0.001, 0.1]，长边的比例
        | { kind: "desaturate"; amount: number }   // [0, 1]，1 = 全灰
        | { kind: "glitch"; blocks; displace; channelSplit;        // 数字信号损坏，见下
                            scanline; colorNoise; darkBias; speed; seed }
        | { kind: "voxel"; blocks; palette; levels;               // 方块世界，见下
                           smooth?; saturate?; faceShade; outline;
                           grain?; ambient?; seed }
        | { kind: "mask-debug" }                   // 调试视图，见下
}
\`\`\`

\`feather\` 现在默认给 0.004 就够。蒙版吃的是模型的连续置信度，软边是真实的，
不需要再用宽模糊去凑 —— 羽化开大的副作用是头发糊成一顶头盔。

**抠图看着不对时，先开 \`{ "kind": "mask-debug" }\`**：它不做任何效果，直接把蒙版画出来
（红 = 判为人，绿 = 过渡带，背景是压暗的原图）。不这么做的话你是在透过马赛克看蒙版，
蒙版的边界和效果自己的块状边缘两个未知量叠在一起，调哪个都像没用。
调试模板记得配 \`"hidden": true\`，别让它出现在模板库里。

### exclude: "face" —— 保护脸部

\`\`\`jsonc
"mask": { "provider": "person", "exclude": "face", "excludePadding": 1.05 }
\`\`\`

用人脸 478 个 landmark 的包围椭圆把脸从「效果作用的区域」里挖掉。
那套点覆盖的正好是额头到下巴、太阳穴到太阳穴的**皮肤**范围，**不含头发** ——
所以脸是干净的而头发照样吃效果，正好是「损坏 / 打码 / 虚化但别毁脸」想要的分工。

写了它 \`perception\` 必须包含 \`"face"\`，否则人脸模型不会被加载，校验器会拦。

挖的是**效果强度**不是原始蒙版值，所以 \`apply\` 两种都对：
inside 时脸上不作用，outside 时脸上保持原样。丢脸时自动关掉保护 ——
脸没了还护着一块，那块会挂在空气里跟着画面走，比不护更怪。

**别拿亮度当「不是脸」的代理。** glitch 的 \`darkBias\` 只是让损坏偏向暗部，
对深色皮肤、昏暗房间、浓妆阴影都会误伤；要真正保护脸就用这个字段。

### voxel —— 把画面重建成 Minecraft 那样的方块世界

\`\`\`jsonc
{ "kind": "voxel", "blocks": 44, "palette": 0.8, "levels": 5, "smooth": 0.7,
  "saturate": 0.35, "faceShade": 0.42, "outline": 0.28, "grain": 0.09, "seed": 11 }
\`\`\`

配 \`mask.provider: "person"\` + \`apply: "outside"\` 就是「人完全不动，只有背景变方块」。

**块色来自当前帧的真实像素**，不是贴一张事先做好的场景图 ——
所以构图和光照是按构造就匹配的，不需要任何对齐工作。代价也在这里：
它是「你的房间被方块化」，不是「Minecraft 的瑞士山谷」。要后者得换成
预渲染场景板，那是另一个效果。

和 \`pixelate\` 的区别不在网格。**只做网格得到的是马赛克**（「画面糊了」），
方块世界还需要三样东西，缺一样就不像：

- \`palette\` 往 MC 方块色靠拢的强度。吸附时**保住原块的亮度**，
  所以调到 1 也不会把光照拍平 —— 颜色是 MC 的，明暗还是这一帧的
- \`faceShade\` 顶边提亮 / 底边压暗。这是「这是个立方体」唯一读得出来的线索，
  给 0 的话只是彩色瓷砖
- \`outline\` 块间接缝。方块要能一个个数出来

调参上踩过的两个坑：

0. **\`blocks\` 和 \`smooth\` 是两个独立的选择，别绑在一起。**
   辨识度来自**大片连续的同一种方块**（一整面石头墙、一片草地），
   不来自「每块颜色量化」—— 逐块独立量化一张有噪点的照片，出来必然是椒盐点。
   连贯靠 \`smooth\`（相邻块共享采样窗口 → 落到同一个调色板项），
   不靠把块调大。我一开始把这两件事绑在一起，为了压椒盐点把块调到 20，
   结果背景里什么都认不出来了。**先用 \`smooth\` 压噪，再单独选块大小。**
1. **\`levels\` 会把暗部量化成纯黑。** 真实房间的暗部是 0.02~0.05，
   \`levels: 5\` 一量化直接归零，半个背景死黑。\`ambient\`（缺省 0.16）是暗部地板，
   MC 的世界里没有纯黑 —— 别把它调到 0。
2. **提饱和是在平均之后做的**，别指望 \`saturate\` 去救灰扑扑的画面 ——
   放在平均之前提的是传感器噪点的彩度，一面米色的墙会长出淡紫、淡黄、
   淡蓝的杂色方块，正好是最毁效果的那种椒盐点。
3. **\`palette\` 和 \`levels\` 一起调猛会把整面墙压成同一块石头。**
   \`levels: 4\` + \`palette: 0.85\` 出来是一片均匀的灰，原来的色彩变化全没了。
   先把 \`levels\` 放到 6~8，再调 \`palette\`。

### glitch

\`\`\`jsonc
{ "kind": "glitch",
  "blocks": 56,          // [8, 200] 短边分几行，错位块的粒度
  "displace": 0.05,      // [0, 0.5] 横向错位强度，画面宽度的比例
  "channelSplit": 0.003, // [0, 0.05] RGB 通道分离
  "scanline": 0.35,      // [0, 1] 扫描线
  "colorNoise": 0.55,    // [0, 1] 色块乱码密度
  "darkBias": 0.75,      // [0, 1] 噪声往暗部集中的程度
  "speed": 8,            // [0.1, 60] 每秒变几次
  "seed": 1337 }         // 必填
\`\`\`

配 \`apply: "inside"\` 就是「只有人坏掉、背景干净」。

**\`darkBias\` 是这个效果对不对味的关键**：真实的信号损坏几乎只出现在暗部，
浅色皮肤是干净的。调到 0 的话脸上也会花，立刻变成廉价滤镜。

\`seed\` 必填，理由同 scatter：损坏是 \`hash(块, 帧号, seed)\` 的纯函数，
用随机数的话 \`renderAt(t)\` 不再确定，渲染回归就不成立。

注意这**不是 datamosh**。真 datamosh 是时间域的（丢 I 帧 + 复用运动矢量），
需要跨帧历史，而引擎是无历史的。这里是逐帧程序化损坏：静态几乎一样，
快速运动时不会有「融化」的拖影。

\`provider: "person"\` 时 \`perception\` 必须包含 \`"segmentation"\`，否则分割模型不会被加载。
\`blocks\` 是真实参数，和菜单文案上写的「240p」没有换算关系。

只有帧效果、没有任何贴纸是合法的：\`"elements": []\` + 一个 \`source\` 就是一个完整模板
（\`apply: "outside"\` + \`desaturate\` = 「只有我是彩色的」）。

\`posterize\` / \`pixel-art\` 只留了枚举值没有实现，写了会被校验拦下来 ——
校验器的名单是从引擎的实现表导出来的，不会出现「能过校验但没效果」。

## 硬约束

1. 锚点只写语义名。数字编号是引擎内部实现，写进 JSON 会被校验拒收。
2. \`scatter\` 和 \`item.jitter\` 必须带 \`seed\`。没有 seed 展开不确定，渲染回归的 golden 对比不成立。
3. \`svg-inline\` 里出现 \`script\` / \`foreignObject\` / \`on*\` 事件属性 / 外链 \`href\` /
   \`style\` 里的 \`url(\` 外链，校验会**拒收**而不是清洗。修掉它，不要绕过。
4. 单模板展开后 ≤ 120 个元素。
5. 引擎里不允许出现 \`if (slug === "...")\`。需要新维度就扩 schema，不要开特例分支。

## 可用人脸锚点（${anchorNames.length} 个）

${anchorNames.join(", ")}

## 可用手部锚点（${handAnchorNames.length} 个）

${handAnchorNames.join(", ")}

指尖是 \`thumb_tip\` / \`index_tip\` / \`middle_tip\` / \`ring_tip\` / \`pinky_tip\`；
\`_mcp\` 是指根、\`_pip\` 和 \`_dip\` 是中间关节、\`wrist\` 是手腕。
`;
}

/** 素材清单：key + viewBox 高宽比。 */
export function buildAssetIndex(): string {
  const rows = listSvgKeys()
    .sort()
    .map((key) => {
      const svg = getSvg(key) ?? "";
      const vb = svg.match(/viewBox\s*=\s*["']([^"']+)["']/)?.[1] ?? "—";
      return `| \`${key}\` | ${vb} | ${extractAspect(svg).toFixed(3)} |`;
    });

  return `素材放在 \`src/content/assets/\`，构建时打包成字符串常量。
高宽比（高/宽）从 viewBox 自动解析，**不要在 JSON 里手填 aspect**——这个字段已经删了。

| key | viewBox | 高/宽 |
|---|---|---|
${rows.join("\n")}

用法：\`"asset": { "kind": "svg-lib", "key": "tear-drop" }\`

清单里没有想要的东西时，按这个顺序找：
1. 换个近似的 key 凑合（大部分「换个形状」的需求其实是换颜色）
2. 写 \`{ "kind": "svg-inline", "svg": "<svg viewBox=...>...</svg>" }\`，必须带 viewBox
3. 都不行才新增文件到 \`src/content/assets/<key>.svg\`，然后重新跑 \`npm run gen:skill-reference\`，
   否则清单里没有你的新 key，后续会话找不到它
`;
}

/** 锚点表。 */
export function buildAnchorReference(): string {
  const groups: [string, string[]][] = [
    ["眼部", ["lower_eyelid", "upper_eyelid", "eye_outer", "iris"]],
    ["中轴", ["nose_bridge", "nose_tip", "forehead", "head_top", "chin", "mouth_center", "upper_lip", "lower_lip"]],
    ["两侧", ["cheek", "temple", "jaw", "ear"]],
  ];
  const all = Object.entries(FACE_ANCHORS) as [string, number][];
  const used = new Set<string>();

  const section = (names: string[]) => {
    const rows: string[] = [];
    for (const prefix of names) {
      const matches = all.filter(([n]) => n === prefix || n === `${prefix}_left` || n === `${prefix}_right`);
      for (const [n, i] of matches) {
        used.add(n);
        rows.push(`| \`${n}\` | ${i} |`);
      }
    }
    return rows.join("\n");
  };

  const body = groups
    .map(([title, names]) => `### ${title}\n\n| 语义名 | mesh 编号（引擎内部，JSON 里不要写） |\n|---|---|\n${section(names)}`)
    .join("\n\n");

  const leftover = all.filter(([n]) => !used.has(n));

  return `JSON 里**只准写左列的语义名**。右列的编号是引擎内部实现，
在 478 个编号里挑数字是幻觉重灾区，语义名就是为了消除这个问题——写数字会被校验拒收。

${body}
${leftover.length ? `\n### 其他\n\n${leftover.map(([n, i]) => `| \`${n}\` | ${i} |`).join("\n")}\n` : ""}
## 成对锚点

\`mirrorPair\` 的 \`anchor\` 写这一列，不是上面的单侧名：

| 成对名 | 展开成 |
|---|---|
${Object.entries(ANCHOR_PAIRS)
  .map(([k, v]) => `| \`${k}\` | ${v[0]} + ${v[1]}（右侧自动 mirror） |`)
  .join("\n")}

## 偏移的单位

\`anchor.offset\` 是 \`[x, y]\`，单位是 **IOD（瞳距）**，不是像素也不是 size 的参照物。
y 为正表示向下。偏移会跟着头部滚转一起旋转。
`;
}

/** 现有模板作 few-shot。 */
export function buildExamples(templates: { slug: string; json: string }[]): string {
  return `这些是仓库里真实跑着的模板，照着改比从零写快。

${templates
  .map(
    (t) => `## ${t.slug}

\`\`\`json
${t.json.trim()}
\`\`\`
`,
  )
  .join("\n")}`;
}

/** /api/generate 用的 system prompt。 */
export function buildSystemPrompt(): string {
  return `你是 AR Studio 的模板设计师。用户描述一个相机特效，你输出一份模板 JSON。

只输出 JSON 本身，不要 markdown 代码围栏，不要任何解释文字。

${buildSchemaReference()}

# 可用素材

${buildAssetIndex()}

# 判断标准

想法能否表达为「平铺元素 + 已有动画原语」？能就写 JSON。
表达不了时不要编造字段——返回一个尽量接近的版本，schema 里没有的维度就放弃掉。
`;
}
