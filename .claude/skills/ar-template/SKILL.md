---
name: ar-template
description: Create, edit, and verify AR Studio filter templates (the JSON files in src/content/templates/). Use this skill whenever the user describes a camera effect, filter, sticker, face decoration, particle effect, or overlay they want — for example "眼睛下面挂金色星星", "add a rain filter", "make the background pixelated", "改一下 crying 模板的眼泪速度" — even if they don't mention templates or JSON explicitly. Also use it when debugging why a template renders wrong, when migrating a template to schema v2, or when adding new SVG assets to src/content/assets/. Do NOT hand-write template JSON without this skill; the verification loop it describes is the only way to check a template without a camera.
---

# AR Studio 模板创作

模板是纯 JSON，引擎不认识任何具体模板。加「莲蓬头」和加「咖啡杯」对代码是同一件事。
你的工作是写 JSON，**几乎永远不需要改引擎代码**。

判断标准：想法能否表达为「平铺元素 + 已有动画原语」。能则写 JSON，不能才考虑动引擎——
而动引擎前先问用户。

## 核心工作流

这是本 skill 存在的理由。不要跳步。

```bash
# 1. 写 JSON 到 src/content/templates/<slug>.json

# 2. 校验。报错会直接告诉你哪里错、可选值是什么、怎么改
npm run validate:templates -- src/content/templates/<slug>.json

# 3. 渲染出图，然后用 Read 工具打开这张 PNG 看
npm run render:preview -- src/content/templates/<slug>.json
# → .preview/<slug>-t0.png

# 4. 图不对就回到 1
```

**第 3 步必做。** 校验通过只说明结构合法，不说明看起来对。
「校验过了但什么都看不见」是最常见的失败，只有把图打开看才能发现。
每次改完都重新渲染并**实际用 Read 打开图片看**，不要凭想象判断。

想看动画的其他时刻：`npm run render:preview -- <file> --t 1.4`
想换脸型 fixture：`--fixture side`（可选 `front` / `side` / `far` / `noface`）

- `far` 用来验「人退远时会不会缩没」——`size.ref` 选错在这张图上最明显
- `noface` 用来验丢脸兜底：face 空间的元素该消失，screen 空间的该还在

改完一个模板后，跑一次全量回归确认没影响别人：

```bash
npm run validate:templates
npm run test:render
```

## 什么时候读哪份 reference

不要一次全读。按需：

| 情况 | 读 |
|---|---|
| 写任何模板前 | `reference/schema.md` |
| 元素要贴在脸上 | `reference/anchors.md` |
| 要用现成贴纸 | `reference/assets.md` |
| 不确定某种排列怎么写 | `reference/examples.md` |
| 卡住了、行为不符合预期 | `reference/gotchas.md` ← 先读这个再猜 |

`reference/` 下前四份**由 `npm run gen:skill-reference` 从源码生成**，是当前代码的真实状态。
若与 `docs/JSON-MODE.md` 冲突，以 reference 为准——JSON-MODE.md 是改造计划，
写在改造之前，已经落后于代码。

## 硬约束

**锚点只写语义名。** `lower_eyelid_left` 对，`145` 错。数字编号是引擎内部实现，
写进 JSON 会被校验拒收。可用名字见 `reference/anchors.md`，不要发明新的。

**`scatter` 生成器必须带 `seed`。** 没有 seed 展开结果不确定，渲染回归的 golden 对比就不成立。

**SVG 是拒收不是清洗。** inline svg 里出现 `script`、`foreignObject`、`on*` 事件属性、
外链 `href`、`style` 里的 `url(` 外链，校验会直接失败并告诉你哪一处。修掉它，不要试图绕过。

**单模板展开后 ≤ 120 个元素。** 生成器容易写出爆炸的数量，校验会拦。

**不要手填 `aspect`。** 这个字段已经删了，高宽比从 SVG 的 viewBox 自动解析。

**引擎里不允许出现 `if (slug === "...")`。** 如果你发现自己想加这样一行，
说明 schema 缺了一个维度——停下来跟用户讨论要不要扩 schema，不要在渲染器里开特例分支。

**不改 `src/engine/occupancy.ts` 的 `at()` 镜像映射。** 它和背景平面的 `scale.x = -1` 是一对。

## 常见需求的写法

**「左右各一个，对称」** → `generate: "mirrorPair"`，别手写两份。右侧会自动带 `mirror: true`。

**「一串往下掉的东西」** → `mirrorPair` 套 `children` 里的 `generate: "trail"`，
动画用 `emit-fall-fade`，相位差写 `trail` 的 `phaseShift`（秒）而不是逐个手填 `phase`。
受重力的东西（眼泪、雨滴）加 `ease: "gravity"`——缺省的线性读起来是匀速下滑，
这是「像贴纸」最直接的来源。整齐得像流水线时给 `item` 加 `jitter`（必须带 `seed`）。

**「贴在皮肤上的东西」**（腮红、纹身、脸彩）→ 加 `blend: "multiply"`；
半透明的水光、眼泪用 `"screen"`；发光的星星光斑用 `"add"`。
缺省的 normal 是一块不透明色块糊在脸上，贴脸类元素基本都不该用它。

**「满屏飘」** → `generate: "scatter"` + `seed`，或者 `columns`。

**「挂在手上 / 指尖上」** → `anchor: { space: "hand", hand: "left"|"right", landmark: "index_tip" }` +
`size: { ref: "palm_width", scale }` + `perception: ["hands"]`。
`hand` 说的是**本人的**左右手，不是画面上的左右（画面是镜像的）。
一个元素绑一只手的一个点，十根指尖就写十个元素。参考 `finger-flowers.json`。

**「拖出一条轨迹 / 种花」** → `asset: { kind: "trail", color, seconds, leaf }`，锚在会动的
东西上（`hand` 或 `face`）。**它是唯一一个几何依赖时间历史的 asset**，所以离线渲染必须走
`stepTo`（harness 已经是了），而且验的时候要用**序列** fixture：单帧数据只有一个点，
画不出带。参考 `finger-flowers.json`。

**「捏合触发」** → `asset: { kind: "pinch-bloom", key, seconds, grow }`。边沿触发，
一次捏合一朵。同样依赖跨帧状态。

**「用 emoji」** → 别写 `kind: "text"` 塞 emoji 字符，那走的是系统 emoji 字体，
macOS 和 Linux 字形不同，golden 只在录它的机器上成立。用 `svg-lib` 的 `emoji-*` 素材
（Twemoji，见 `src/content/assets/CREDITS.md`），缺哪个照那份文档加。

**「屏幕上固定一个东西，不跟脸动」** → `anchor: { space: "screen", nx, ny }` +
`size: { ref: "vw", scale }`。注意 `space` 和 `size.ref` 是正交的：
`space: "face"` + `ref: "vw"` 也合法，表示「跟着脸平移但按屏幕定大小」，人退远时不会缩小。

**「换个颜色/换个形状」** → 优先在 `reference/assets.md` 里找现成 key。
找不到再写 `svg-inline`，仍然找不到才新增素材。

**「背景打码 / 只有人清晰」** → 不是元素，是和 `elements` 平级的 `source` 字段。
见 `reference/schema.md` 的帧效果一节，参考 `lowres-life.json`。
现在有三种：`pixelate` / `blur` / `desaturate`。只有帧效果、`elements: []` 是合法模板，
参考 `colorful-me.json`（「只有我是彩色的」）。

**「生成器覆盖不了的怪排列」**（比如摆成心形）→ 直接输出平铺元素列表，不用生成器。
两者完全等价。

## 新增 SVG 素材时

素材是构建时打包成字符串常量的，不走文件系统。两处都要加：
`src/content/assets/<key>.svg` 和 `src/engine/svg-assets.ts` 的 `SVG_LIB`。必须带 `viewBox`。

加完后重新生成 reference：

```bash
npm run gen:skill-reference
```

否则 `reference/assets.md` 里没有你的新 key，后续会话找不到它，CI 也会因为
reference 与源码不一致而失败。

## 遇到 schema 表达不了的需求

先确认真的表达不了——大部分「做不到」其实是没找对维度组合。确认之后，
**不要自己改引擎**，把情况告诉用户，说明缺的是哪个维度、大概要动哪个文件。
已知需要动引擎的类别：新感知能力、粒子物理新行为、新的全帧效果（`source.effect`）。
