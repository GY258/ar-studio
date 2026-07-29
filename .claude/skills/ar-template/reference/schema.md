<!-- 由 npm run gen:skill-reference 从源码生成，不要手改 -->

# 模板 Schema

## 模板骨架

```jsonc
{
  "slug": "kebab-case",                 // 小写字母 / 数字 / 连字符
  "name": { "zh": "中文名", "en": "English" },
  "category": "face | sticker | fun | ...",
  "sort_order": 60,                     // 列表排序，小的在前
  "price_cents": 0,
  "hidden": false,                      // 可选。true = 不进模板库列表，但 /studio/<slug> 仍可直接访问
  "schema_version": 2,
  "template_type": "facetrack | overlay",
  "perception": ["face"],               // 用到什么感知能力就写什么
  "preview": {},
  "elements": [ /* ElementV2 或生成器 */ ],
  "source": { /* 可选，帧效果 */ }
}
```

`template_type` 只影响默认的 perception，元素本身不分类型——
一个模板里同时有跟脸的元素和固定在屏幕上的元素是合法的。

## ElementV2

三个维度彼此正交，不要互相耦合：

```ts
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

type ElementAnchor =
  | { space: "screen"; nx: number; ny: number }   // 归一化屏幕坐标，[-0.2, 1.2]
  | { space: "face";   landmark: FaceAnchorName;  // 只写语义名，绝不写数字
      offset?: [number, number];                  // 单位 IOD（瞳距），y 正数向下
      mirror?: boolean }                          // 水平翻转

type SizeRef = "vw" | "iod" | "eye_width" | "face_width"
type SizeFit = "width" | "font"
```

**`size.ref` 与 `anchor.space` 正交。** `space: "face"` + `ref: "vw"` 是合法且常用的
组合，含义是「跟着脸平移，但按屏幕定大小」，人退远时不会跟着缩小。反过来
`space: "screen"` + `ref: "iod"` 也合法。别因为锚在脸上就默认尺寸得用 iod。

**`size.fit` 决定 scale 在量什么。** `width` = 元素画出来有多宽，高度按素材比例推；
`font` = 字号有多大，宽度由内容长度决定。缺省时 text 走 `font`，其余走 `width`。
「这行字占屏幕 1/3 宽」和「这行字 28px 高」是两个诉求，猜哪个都会猜错，所以显式写。
svg 和 gradient 只有宽度一种含义，写 `fit: "font"` 也按宽度处理。

高度一律按 viewBox 的高宽比自动算——不要手填 aspect，这个字段已经没有了。

**`blend` 决定元素怎么和背后的画面融。** 缺省 `normal` 是一块不透明的色块糊在脸上，
真实的眼泪是折射的，颜色主要来自它背后的皮肤：

- `multiply` 压暗底色 → 腮红、纹身、脸彩这类「长在皮肤上」的
- `screen` 提亮但保留底下的明暗 → 眼泪、水光
- `add` 发光 → 星星、光斑

贴在脸上的半透明东西默认就该考虑 `multiply` 或 `screen`，别一律用 normal。

**`interactive`** 让用户在画面上直接拖动元素、滚轮或双指缩放它。
只对 `space: "screen"` 有意义——face 空间的位置由 landmark 决定，拖了下一帧就被拉回去。
调整量只存在渲染器里，不写回 JSON，切模板即重置。假 UI 面板、水印这类
「作者给个初始摆位，用户自己挪」的元素适合开这个。

## AnimationV2

多条动画叠加。`period` 单位秒，`phase` 归一化到一个周期（0~1）。

```ts
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
```

**缺省的 `linear` 读起来是「一张贴纸在匀速下滑」。** 水是加速下落的，
眼泪、雨滴这类受重力的东西写 `ease: "gravity"`，起步慢、落到下巴快。

`ease` 只有 `fall` 和 `emit-fall-fade` 支持，它们是「0→1 走一趟」的过程。
`float` / `pulse` / `spin` 是周期性的，缓动套在相位上会在每个周期的接缝处
留一个速度拐折（转一圈然后顿一下），所以写了会被校验拒收，不是悄悄不生效。

## 生成器

和平铺元素完全等价，写在 `elements` 里，loadTemplate 阶段展开。
生成器覆盖不了的排列（比如摆成心形）直接写平铺列表就行，两者没有优劣。

```ts
| { generate: "mirrorPair"; anchor: PairName; offset?: [number, number];
    item: Item; children?: Generator[] }
  // 左右各一个。右侧自动带 mirror: true 并翻转 x 偏移
| { generate: "trail"; count: number; step: number; decay?: number;
    direction?: "down" | "down-out"; phaseShift?: number; item: Item }
  // 一串。step 是 y 间距（IOD），phaseShift 是相邻两个的起始时间差（秒）
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
```

`item` 是「去掉 id 和 anchor 的 ElementV2」——这两个字段由生成器负责填，写了会被拒收。

### item.jitter：把整齐的一批打散

生成器默认产出一批一模一样的东西。`trail` 写 `step: 0 + decay: 1` 时三滴眼泪
起点相同、大小相同，只有相位差，于是沿同一条线单列前进，像流水线上的零件。
真实的眼泪大小不一、路径略有偏离、时间不规整。

```ts
jitter?: {
  size?: number;              // 尺寸倍率的随机半宽，0.2 = ±20%
  phase?: number;             // 归一化相位的随机偏移
  offset?: [number, number];  // 位置的随机偏移，单位 IOD
  seed: number;               // 必填，理由同 scatter
}
```

支持 `mirrorPair` / `trail` / `ring` / `spread`。`columns` 是版式（标签逐个对齐），
抖了就歪，写了会被拒收；`scatter` 本来就是随机的，用它自己的 seed / sizeRange。

## 成对锚点（mirrorPair 的 anchor）

- `lower_eyelid` → lower_eyelid_left / lower_eyelid_right
- `upper_eyelid` → upper_eyelid_left / upper_eyelid_right
- `eye_outer` → eye_outer_left / eye_outer_right
- `iris` → iris_left / iris_right
- `cheek` → cheek_left / cheek_right
- `temple` → temple_left / temple_right

写 `lower_eyelid`，不是 `lower_eyelid_left`。

## 帧效果 source

和 `elements` 平级。元素是「画在上面的东西」，source 是「源视频怎么被画出来」，两回事。

```ts
{
  mask: { provider: "person" | "none";     // face-ellipse 留了枚举没实现
          feather?: number;                // [0, 0.1]
          onLost?: "clear" | "hold" | "full" },
  apply: "inside" | "outside",             // 效果作用在人身上 / 背景上
  effect: { kind: "pixelate";   blocks: number }   // blocks ∈ [4, 200]，短边格数
        | { kind: "blur";       radius: number }   // [0.001, 0.1]，长边的比例
        | { kind: "desaturate"; amount: number }   // [0, 1]，1 = 全灰
        | { kind: "glitch"; blocks; displace; channelSplit;        // 数字信号损坏，见下
                            scanline; colorNoise; darkBias; speed; seed }
        | { kind: "mask-debug" }                   // 调试视图，见下
}
```

`feather` 现在默认给 0.004 就够。蒙版吃的是模型的连续置信度，软边是真实的，
不需要再用宽模糊去凑 —— 羽化开大的副作用是头发糊成一顶头盔。

**抠图看着不对时，先开 `{ "kind": "mask-debug" }`**：它不做任何效果，直接把蒙版画出来
（红 = 判为人，绿 = 过渡带，背景是压暗的原图）。不这么做的话你是在透过马赛克看蒙版，
蒙版的边界和效果自己的块状边缘两个未知量叠在一起，调哪个都像没用。
调试模板记得配 `"hidden": true`，别让它出现在模板库里。

### glitch

```jsonc
{ "kind": "glitch",
  "blocks": 56,          // [8, 200] 短边分几行，错位块的粒度
  "displace": 0.05,      // [0, 0.5] 横向错位强度，画面宽度的比例
  "channelSplit": 0.003, // [0, 0.05] RGB 通道分离
  "scanline": 0.35,      // [0, 1] 扫描线
  "colorNoise": 0.55,    // [0, 1] 色块乱码密度
  "darkBias": 0.75,      // [0, 1] 噪声往暗部集中的程度
  "speed": 8,            // [0.1, 60] 每秒变几次
  "seed": 1337 }         // 必填
```

配 `apply: "inside"` 就是「只有人坏掉、背景干净」。

**`darkBias` 是这个效果对不对味的关键**：真实的信号损坏几乎只出现在暗部，
浅色皮肤是干净的。调到 0 的话脸上也会花，立刻变成廉价滤镜。

`seed` 必填，理由同 scatter：损坏是 `hash(块, 帧号, seed)` 的纯函数，
用随机数的话 `renderAt(t)` 不再确定，渲染回归就不成立。

注意这**不是 datamosh**。真 datamosh 是时间域的（丢 I 帧 + 复用运动矢量），
需要跨帧历史，而引擎是无历史的。这里是逐帧程序化损坏：静态几乎一样，
快速运动时不会有「融化」的拖影。

`provider: "person"` 时 `perception` 必须包含 `"segmentation"`，否则分割模型不会被加载。
`blocks` 是真实参数，和菜单文案上写的「240p」没有换算关系。

只有帧效果、没有任何贴纸是合法的：`"elements": []` + 一个 `source` 就是一个完整模板
（`apply: "outside"` + `desaturate` = 「只有我是彩色的」）。

`posterize` / `pixel-art` 只留了枚举值没有实现，写了会被校验拦下来 ——
校验器的名单是从引擎的实现表导出来的，不会出现「能过校验但没效果」。

## 硬约束

1. 锚点只写语义名。数字编号是引擎内部实现，写进 JSON 会被校验拒收。
2. `scatter` 和 `item.jitter` 必须带 `seed`。没有 seed 展开不确定，渲染回归的 golden 对比不成立。
3. `svg-inline` 里出现 `script` / `foreignObject` / `on*` 事件属性 / 外链 `href` /
   `style` 里的 `url(` 外链，校验会**拒收**而不是清洗。修掉它，不要绕过。
4. 单模板展开后 ≤ 120 个元素。
5. 引擎里不允许出现 `if (slug === "...")`。需要新维度就扩 schema，不要开特例分支。

## 可用锚点（24 个）

lower_eyelid_left, lower_eyelid_right, upper_eyelid_left, upper_eyelid_right, eye_outer_left, eye_outer_right, iris_left, iris_right, nose_bridge, nose_tip, forehead, head_top, chin, mouth_center, upper_lip, lower_lip, cheek_left, cheek_right, temple_left, temple_right, jaw_left, jaw_right, ear_left, ear_right
