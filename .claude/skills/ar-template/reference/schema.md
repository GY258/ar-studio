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
  animations?: AnimationV2[];
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

## AnimationV2

多条动画叠加。`period` 单位秒，`phase` 归一化到一个周期（0~1）。

```ts
| { preset: "float";  amplitude: number; period: number; phase?: number }
  // 上下浮动。amplitude 是画面高度的比例，0.01 = 1%H
| { preset: "fall";   period: number; phase?: number }
  // 从画面顶飞到画面底并循环。走整屏高度，与锚点的 ny 无关
| { preset: "pulse";  scaleRange: [number, number]; period: number; phase?: number }
| { preset: "spin";   period: number; phase?: number }
| { preset: "emit-fall-fade";
    distance: number;        // 位移距离，单位 IOD
    period: number;
    phase?: number;
    outwardDrift?: number;   // 默认 0.08，越往下越往外撇
    shrink?: number;         // 默认 0.3
    emitPortion?: number;    // 默认 0.15，冒出来占周期的比例
    fadePortion?: number }   // 默认 0.15
```

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
  effect: { kind: "pixelate"; blocks: number }   // blocks ∈ [4, 200]，短边格数
        | { kind: "blur"; radius: number }       // 尚未实现
}
```

`provider: "person"` 时 `perception` 必须包含 `"segmentation"`，否则分割模型不会被加载。
`blocks` 是真实参数，和菜单文案上写的「240p」没有换算关系。

## 硬约束

1. 锚点只写语义名。数字编号是引擎内部实现，写进 JSON 会被校验拒收。
2. `scatter` 必须带 `seed`。没有 seed 展开不确定，渲染回归的 golden 对比不成立。
3. `svg-inline` 里出现 `script` / `foreignObject` / `on*` 事件属性 / 外链 `href` /
   `style` 里的 `url(` 外链，校验会**拒收**而不是清洗。修掉它，不要绕过。
4. 单模板展开后 ≤ 120 个元素。
5. 引擎里不允许出现 `if (slug === "...")`。需要新维度就扩 schema，不要开特例分支。

## 可用锚点（24 个）

lower_eyelid_left, lower_eyelid_right, upper_eyelid_left, upper_eyelid_right, eye_outer_left, eye_outer_right, iris_left, iris_right, nose_bridge, nose_tip, forehead, head_top, chin, mouth_center, upper_lip, lower_lip, cheek_left, cheek_right, temple_left, temple_right, jaw_left, jaw_right, ear_left, ear_right
