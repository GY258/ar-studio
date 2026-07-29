# 效果质量评审

> 目标位置：`docs/EFFECT-QUALITY.md`。改动落在 `src/engine/`、`src/content/templates/`、`src/content/assets/`。
> 前置阅读：`docs/PRODUCTION-TODO.md`（那份修的是**对不对**，这份修的是**好不好看**）。两份可以并行，但 PRODUCTION-TODO §1 的坐标系必须先修——在错的坐标系上评判 facetrack 的观感没有意义。

## 0. 结论

三类效果都卡在 70 分附近，**原因不是参数没调好，是各自撞到了一个架构性天花板**。调滑块调不出来。

| 类型 | 天花板 | 一句话 |
|---|---|---|
| particle | 粒子永远在人前面，且落地即消失 | 没有空间感，没有累积 |
| overlay | 只有一个帧效果，且蒙版的软信息被扔了 | 一个模板一个 trick，边缘是硬抠的 |
| facetrack | 刚性四边形贴纸，动画曲线全线性，不响应表情 | 是贴纸不是妆效，是循环不是反应 |

另有一条横跨三类的：**全片没有任何后期**（`renderer.render()` 直出，没有 EffectComposer）。商用相机滤镜没有一个是裸输出的。

还有一个共同的浪费——MediaPipe 有三个输出被显式关掉，每一个正好对应一类效果的上限：

```ts
face-tracker.ts:   outputFaceBlendshapes: false          // → facetrack 不响应表情
face-tracker.ts:   （未设置 outputFacialTransformationMatrixes）  // → 侧脸脱模，见 PRODUCTION-TODO §7
segmentation.ts:   outputConfidenceMasks: false          // → 抠图边缘是硬阈值
```

三个开关，三个档次。

---

## 1. particle（cloud / shower / coffee）

### □ P-1. 粒子永远画在人前面 ★最高优先

**病灶**。渲染顺序 `bg=0 → particles=2 → prop=3 → elements=5`，且 `dotMat` / `liqMat` 都是 `depthTest: false`。背景平面画的就是人，所以**每一颗雪都在人前面**。

雪从人身后飘过去，是「这东西真的在我房间里」最强的单一信号。现在一颗都没有，全部糊在脸上——这是「看着像贴上去的」最大来源，比任何贴图质量问题都大。

**改法**。占据场已经知道人在哪了，缺的只是把它送进粒子的 fragment shader：

- 每颗粒子发射时随机一个深度 `z ∈ [0,1]`，塞进现有的 attribute 数组（多一个 `Float32Array(MAX)`，零额外 draw call）。
- `z < 0.5` 判定为「在人后面」，fragment 里采样 mask，落在人体内就 `discard`。
- mask 纹理 `maskTex` 已经存在了（`MaskField` 喂给帧效果用的那张），直接复用，不用新建。

注意 `MaskField` 只在模板声明了 `source.effect` 时才建。要让 particle 模板也拿到，得把它的生命周期从「帧效果专用」提到「只要 perception 含 segmentation 就维护」。这是本条唯一的结构改动。

**判据**：站在画面中间，肉眼能数出至少三成的雪是从身后过去的；人快速侧移时前后关系不闪。

### □ P-2. 落地即消失，永远堆不起来

**病灶**。`particles.ts / step()`：

```ts
if (s.settle) this.life[i] = Math.min(this.life[i], 1.4 + Math.random() * 1.6);
```

雪落到肩膀上 1.4~3 秒就没了。代码注释里那套「头顶水平所以雪堆住、肩膀倾斜所以往下溜」的物理是对的，但**堆住的雪三秒后蒸发**，所以永远看不到积累。

积雪从无到有慢慢盖住肩膀和头顶，是这个效果唯一真正的爽点。现在等于把高潮砍掉了。

**改法**。落定的粒子不该继续留在粒子池里被逐帧积分（既费 CPU 又会缓慢蠕动）。改成**盖章进一张累积贴图**：

- 一张和 `MaskField` 同分辨率的 R8 累积缓冲，粒子 settle 时在对应位置加一笔，然后 `life = 0` 释放槽位。
- 累积值缓慢衰减（比如 30s 半衰），另外**人一动就该掉**——用 mask 的帧间差分做局部清除，否则人转身了雪还挂在原来的空气里。
- 渲染成一层贴图，排在粒子和人之间。

顺带解决粒子池压力：现在 settled 粒子占着槽位还在跑完整积分。

**判据**：静止站 20 秒，肩膀和头顶有肉眼可见的积雪轮廓；抖一下肩膀，那一块的积雪掉下去。

### □ P-3. 所有粒子在同一个平面上

**病灶**。`emit()` 里 `size`、`speed` 都是均匀随机，没有任何深度概念。所有雪花一样清晰、一样的速度分布、一样的亮度。真实的雪读起来是分层的：近处大、糊、快，远处小、锐、慢。

**改法**。P-1 已经引入的 `z` 顺手全用上：`size ×= lerp(0.5, 1.6, z)`、`speed ×= lerp(0.7, 1.3, z)`、`alpha ×= lerp(0.55, 1.0, z)`。三行，视觉分层立刻出来。

### □ P-4. 加法混合在亮背景上直接消失

**病灶**。`applySubstance()`：

```ts
this.dotMat.blending = s.settle ? THREE.AdditiveBlending : THREE.NormalBlending;
```

雪走加法混合。白色加法叠在白墙、窗边、浅色沙发上 = **完全看不见**。在你调试用的深色背景上它很漂亮，到用户家里就没了。这类「在我这好看在你那不好看」的 bug 最难通过自测发现。

**改法**。普通混合 + 在 point shader 里给一圈极淡的暗边（`smoothstep` 的外沿混一点暗色），白雪就能在白墙上读出来。想保留通透感的话，用「普通混合打底 + 亮核加法」的两段式，代价是 fragment 多几行。

**判据**：对着白墙拍，雪清晰可辨。

### □ P-5. twinkle 是同频闪烁

`const a = fade * (0.55 + 0.45 * Math.sin(t * 7 + this.phase[i]))` —— 全场 7 rad/s 同一个频率，只有相位不同。眼睛会认出这个周期，读作「整体在频闪」而不是「颗粒各自在闪」。每颗粒子存一个自己的频率（`phase` 数组旁边加个 `freq`），成本一样。

### □ P-6. 雪花只能是圆点

`gl_PointSize` 画出来的是屏幕对齐的正方形，**没法旋转**，所以任何非圆对称的雪花贴图都用不了。这是 `THREE.Points` 这条路的硬上限。

液体那条线已经是 instanced quad 了。想要真雪花形状（六角、翻转、旋转），得把圆点也迁到 instanced quad——一次性的活，之后 size/rotation/贴图都自由了。**这条不做也能到 85，做了才有 90。**

### □ P-7. 溅射太廉价

`splash()` 三个问题：

- **数量与冲击力无关**。`for (let k = 0; k < s.splash; k++)`，`s.splash` 是常数 3。轻轻淋和猛冲一样溅三滴。应该按 `impact` 缩放。
- **阈值是硬开关**。`if (s.splash && impact > 260)` —— 259 不溅，261 溅三滴。需要软过渡。
- **溅射粒子不参与碰撞**。`if (field.seen && !this.isSplash[i] && ...)`，所以水花直接穿过身体飞走。

另外溅射粒子 `streak = 0` 全是圆点，高速水花应该是拉伸的。

### □ P-8. 液体不留痕

液体碰到人 `life = min(life, 1.0 + rand)`，一两秒后凭空消失，皮肤上什么都没留下。淋水淋了半天人是干的。

接 P-2 的累积缓冲：液体 settle 时也盖章，只是用不同的通道/材质渲染成「湿痕」（压暗 + 提高光）。同一套机制两种用途。

### □ P-9. 道具是程序化画的 + 引擎里有 slug 硬编码

`props.ts` 用 canvas 图元画云和花洒，画得挺认真，但读起来就是占位图。`emitter.asset` 字段早就留好了，换成设计出的 webp 零代码。

另外 `engine.ts / layoutProp()`：

```ts
const pw = this.W * 0.24 * (aspect > 0.7 ? 0.85 : 1) * (this.cfg.slug === "cloud" ? 1.4 : 1);
```

`slug === "cloud"` 是硬编码在引擎里的特例，和 README 那句「引擎不认 slug」直接冲突。挪进 JSON（`emitter.scale`）。

---

## 2. overlay（lowres-life）

### □ O-1. 分割的软信息被扔掉了 ★最高优先

**病灶**。`segmentation.ts`：

```ts
outputCategoryMask: true,
outputConfidenceMasks: false,
```

然后 `MaskField.ingest()` 里：

```ts
const v = raw[...] !== bgVal ? 1 : 0;   // 连续 → 二值
...
if (this.blurRadius > 0) boxBlur(...)   // 再用盒式模糊凑回软边
```

模型本来输出的是连续的 0~1 置信度，含有头发丝、耳朵边缘、肩膀轮廓的真实软过渡。代码先把它砍成 0/1，**扔掉全部软信息**，再拿一个各向同性的盒式模糊硬凑回去。凑出来的是均匀粗边——头发糊成一顶头盔，这就是用户感觉「抠得不准」的主要来源。

**改法**。开 `outputConfidenceMasks: true`，`MaskSink` 的签名从 `Uint8Array` 换成 `Float32Array`，`ingest` 里去掉二值化那一步直接用。羽化半径可以随之调小甚至归零。

代价：`OccupancyField` 也吃同一份数据，它需要的恰好是粗和硬（注释里写清楚了「粗和糊对碰撞是优点」），所以两个场要么各取所需（confidence → occupancy 时自己阈值化），要么同时申请两种 mask。前者更省。

fixture 是 PNG 存的灰度图，本来就是 8bit 连续值，重录成本很低。

**判据**：头发边缘能看出发丝级的过渡而不是一圈均匀晕开；耳朵不糊成一坨。

### □ O-2. 马赛克边缘会渗到人身上

`smoothstep(0.42, 0.58, mask)` 是对称过渡，意味着**人的轮廓外侧半个羽化宽度内的马赛克块会压到人身上**。块很大（`blocks: 56`）的时候，一整块糊斑贴在肩膀上，观感是「抠错了」。

在羽化之前先向内腐蚀 1~2 px，过渡带就整体落在人体外侧。`boxBlur` 已经有了，腐蚀是同结构的一趟 min 滤波。

### □ O-3. 整个 overlay 类只有一个效果

`setupSourceEffect()`：`if (!source || source.effect.kind !== "pixelate")` —— 除了马赛克什么都不支持。一个模板一个 trick，这个类目就一个模板。

同一段注入 shader 里，每个新效果大约五行：

| kind | 实现 | 模板名 |
|---|---|---|
| `blur` | 已有的 gridUv 换成多次采样平均 | 背景虚化（人像模式） |
| `desaturate` | `mix(gray, rgb, m)` | **只有我是彩色的** |
| `posterize` | `floor(c * n) / n` | 低色深 |
| `colorGrade` | 两组 lift/gamma/gain | 人是暖的世界是冷的 |

**「只有我是彩色的」比「只有我是高清的」传播性强得多，而且几乎不要钱。** 这是投入产出比最高的一条。

### □ O-4. 马赛克读作「打码」不是「低画质」

`gridUv = (floor(vMapUv * blocks) + 0.5) / blocks` —— 只量化了位置，没量化颜色。真正的「低画质」观感需要色深也降下来。加一行 posterize（O-3 里那条），观感从「打了马赛克」变成「这是一台很烂的摄像头」，梗才成立。

网格固定在屏幕空间，人一动内容在静态格子里爬行会有轻微沸腾感。加一点点有序抖动（4×4 Bayer）能压掉，也更像老设备。

---

## 3. facetrack（crying）

### □ F-1. 动画曲线全是线性 / 纯正弦 ★改动最小、回报最大

`animations.ts` 五个原语，**没有一个有缓动**：

```ts
state.positionY -= p * iod * anim.distance;   // p 线性
state.outwardX   = p * iod * (outwardDrift);  // p 线性
shrinkFactor = 1 - shrink * p;                // p 线性
```

水是**加速**下落的。线性下降读起来就是「一张贴纸在匀速往下滑」，这是眼泪不像眼泪最直接的原因。`float`/`pulse` 用纯 `sin`，`spin` 用线性——所有东西都在做同一种匀速运动，整体观感机械。

**改法**。`AnimationV2` 加一个 `ease?: "linear" | "in" | "out" | "inout" | "gravity" | "bounce"`，`evaluateAnimations` 里对 `progress` 过一遍映射函数。一个小函数，**所有模板同时受益**，且完全向后兼容（默认 `linear`，现有 golden 不动）。

眼泪应该是 `gravity`（即 `p²`）。

**判据**：眼泪起步慢、落到下巴快，肉眼能读出加速。

### □ F-2. 三滴眼泪是传送带

`crying.json` 的 trail：

```jsonc
{ "generate": "trail", "count": 3, "step": 0, "decay": 1, "phaseShift": 0.9 }
```

`step: 0` + `decay: 1` = 三滴**起点完全相同、大小完全相同**，只有相位差。于是它们沿同一条线单列前进，像流水线上的零件。

真实的眼泪：大小不一、路径略有偏离、时间不规整。

**改法**。生成器加 `jitter: { size?, phase?, offset? }`，沿用 `scatter` 那条「必须带 seed」的纪律——同一份 JSON 在任何机器上展开一致，golden 对比照常成立（JSON-MODE §2.5 已经立好这个规矩了，直接套用）。

### □ F-3. 贴纸是刚性四边形，不贴合脸

每个元素是一张 quad，定位只有 4 个自由度：x、y、scale、roll。脸颊是曲面，泪痕是一个平的长方形横在上面；胖脸瘦脸一个样；张嘴闭嘴一个样。

这是 facetrack 的真天花板。JSON-MODE §5 把「新感知能力」划到引擎工作那一侧，这条同理：需要 `asset.kind: "mesh"`，把贴图映射到 MediaPipe canonical face 三角剖分的一个子集上，跟着 landmark 形变。

腮红、泪痕、脸彩、纹身这一整类都依赖它。**不做能到 80，做了才有 90。** 建议单独立项，不要塞进这一轮。

### □ F-4. 元素不参与和皮肤的混合

所有元素统一 `MeshBasicMaterial({ transparent: true })`，普通混合。于是 `#62C3F2` 的不透明蓝色块盖在脸上——真实的眼泪是折射的，颜色主要来自它背后的皮肤。腮红更明显：现在是一层浮在脸前面的雾，不是长在皮肤上的红。

**改法**。`ElementV2` 加 `blend?: "normal" | "add" | "screen" | "multiply"`。

- 腮红 → `multiply`，立刻贴到皮肤上
- 眼泪 → `screen` 或低不透明度 + 高光
- 星星、光斑 → `add`

一个字段，映射到 three 的四个常量，改动量极小，观感差别很大。

### □ F-5. 眼泪是循环，不是反应

`emit-fall-fade` 固定 2.8s 周期无限循环，跟人做什么表情毫无关系。人在笑，眼泪照流。这是「一个滤镜」和「一个活的滤镜」的分界。

`face-tracker.ts` 里 `outputFaceBlendshapes: false` —— MediaPipe 现成能给 52 个表情系数（`eyeBlinkLeft/Right`、`browDownLeft`、`mouthFrownLeft`、`jawOpen`…），一行开关的事，现在明确关着。

**改法**。

- `FaceFrame` 增加 `blendshapes: Record<string, number>`。
- 动画原语加触发/调制通道：`trigger?: { shape: string; threshold: number }`（眨眼落一滴泪）和 `intensity?: { shape: string }`（皱眉越狠泪越多）。
- 语义名同样锁在引擎侧映射表里，JSON 里只准写 `blink` / `frown` / `mouth_open` 这种，和 `FACE_ANCHORS` 一个待遇。

这条是 facetrack 从「好看」到「好玩」的那一步，也是最容易做成传播点的。

### □ F-6. `(T_T)` 是占位

屏幕底部锚一行 `(T_T)` 白字，读起来像调试输出。要么删掉，要么做成设计过的字形元素。

---

## 4. 横跨三类

### □ X-1. 没有任何后期

`engine.ts / loop()` 结尾就一句 `this.renderer.render(this.scene, this.camera)`。没有 EffectComposer，没有 bloom、没有颗粒、没有暗角、没有调色。

商用相机滤镜没有一个是裸输出的。**一个全局 look pass 会同时抬高三个类目**，而且它不挑内容：

- 轻微 bloom（只对亮部）→ 雪和水立刻通透
- 极淡的 grain → 掩盖分割边缘和 SVG 栅格化的瑕疵，同时「电影感」
- 暗角 + 调色 LUT → 廉价感消失得最快的一项

JSON-MODE §5 已经把 `colorGrade` 标成「一次性引擎活」，判断是对的。一个 render target + 一个全屏 quad。

代价要认：多一次全屏 pass，移动端要计入 PRODUCTION-TODO §5 的降级档位（低档关 bloom 只留 grade）。

### □ X-2. 效果质量没有任何自动判据

现有的 `test/render.spec.ts` 验的是「位置对不对」「周期闭不闭合」，全是正确性。**观感没有任何回归保护**——调一个参数把雪调难看了，CI 全绿。

不需要做得多复杂，两条统计断言就能挡住大部分退化：

- 粒子在人体前后的分布比例（挡住 P-1 被"优化"掉）
- 元素相对锚点的位移曲线的二阶差分符号（挡住 F-1 的缓动被改回线性）

---

## 5. 优先级

按「投入 ÷ 观感提升」排。

### 第一梯队 · 小改动，立刻能看出来

| # | 条目 | 工时 |
|---|---|---|
| F-1 | 缓动函数（所有模板同时受益） | 半天 |
| F-4 | 元素 blend mode | 半天 |
| O-3 | 帧效果补 desaturate / posterize / blur | 1 天 |
| P-4 | 雪的混合模式（亮背景上不消失） | 半天 |
| P-3 | 粒子深度分层（三行） | 1 小时 |
| P-5 | twinkle 每粒独立频率 | 1 小时 |
| F-2 | 生成器 jitter | 半天 |

这一梯队做完约 3 天，60 → 75。

### 第二梯队 · 架构性，决定天花板

| # | 条目 | 工时 |
|---|---|---|
| P-1 | 粒子的人体遮挡 ★ | 2 天 |
| O-1 | confidence mask 替代 category mask ★ | 1 天 |
| F-5 | blendshape 驱动 ★ | 2 天 |
| P-2 | 累积缓冲（积雪 / 湿痕） | 3 天 |
| X-1 | 后期 pass | 2 天 |
| O-2 | 蒙版腐蚀 | 半天 |

这一梯队做完约 10 天，75 → 88。带 ★ 的三条各自解锁一个类目的上限，且互相独立，可以并行。

### 第三梯队 · 单独立项

| # | 条目 | 工时 |
|---|---|---|
| F-3 | face mesh 变形（腮红/脸彩这一整类的前提） | 1 周+ |
| P-6 | 圆点迁到 instanced quad（真雪花形状） | 3 天 |
| P-7/P-8 | 溅射与液体痕迹 | 3 天 |
| P-9 | 道具素材外包 + 去掉 slug 硬编码 | 看设计 |
| X-2 | 观感回归断言 | 2 天 |

### 建议顺序

先做第一梯队全部（快，且能立刻验证方向对不对），再挑第二梯队带 ★ 的三条。**P-1 单独一条的观感增益可能超过整个第一梯队之和**——但它依赖 `MaskField` 的生命周期改动，所以放在第一梯队跑通之后做，风险更可控。

F-3 不要塞进这轮。它是一个新渲染路径，和 JSON-MODE 里「想法能否表达为『平铺元素 + 已有动画原语』」的判断标准正面冲突——那条标准说得对，这就是该动引擎的时候，但要单独排期。
