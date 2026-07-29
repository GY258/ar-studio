# 效果优化 · 第一批实施规范

> 目标位置：`docs/EFFECT-BATCH-1.md`。这是一份**给执行者的规范**，不是讨论文档。
> 上游：`docs/EFFECT-QUALITY.md`（为什么做）。本文件只写**做什么、怎么验**。
> 范围：8 个任务，预计 3 天。

## 0. 这批为什么可以现在做

**这一批 golden 零作废。** 这是选择它打头阵的唯一理由，也是最重要的验收信号：

- 任务 1–3 是纯扩表面，所有新字段有默认值且默认值 = 现有行为；
- 任务 4–6 只动粒子，而 5 个 particle 模板**本来就没有 golden**（`renderAt()` 不 step 粒子，`test/golden/` 里只有 crying / emotions / lowres-life / raindrops 四个非粒子模板）；
- 任务 7–8 只影响声明了新 `effect.kind` 的模板，现有模板一个都没声明。

所以：

> **`npm run validate:templates && npm run test:render` 必须全绿，且不许重新生成任何 golden。**

这条是整批的总闸。任何一个 golden 需要重录，说明改动越界了，回去查。

## 1. 不变量（改动前先读，违反即回滚）

1. **不许改 `src/content/templates/*.json`。** 一行都不许。本批只扩引擎能力，不改任何模板的表现。让 crying 用上新的缓动是**下一个 commit** 的事——代码改动和视觉改动必须可分离，否则 golden 变了你分不清是哪一边导致的。
2. **不许重录 golden**，不许加 `--update-golden`。
3. **`renderAt(t)` 必须保持无时钟、无 rAF、无未播种随机。** 新引入的任何随机必须走 `generators.ts` 里现成的 `mulberry32(seed)`，或由调用方传入确定的种子。这是 L2 成立的前提。
4. **镜像约定不许动。** 背景平面 `scale.x = -1`、占据场 `u = 0.5 - wx/w`、元素 `cx = (0.5 - lm.x) * ...` 是一套，改一处必须改全部——本批不需要碰任何一处。
5. **引擎里不许出现 `slug === "..."` 判断。** （注：`engine.ts / layoutProp()` 现存一处 `cfg.slug === "cloud" ? 1.4 : 1` 的违例，本批不修，但不许新增。）
6. **所有新增 schema 字段必须可选，且缺省行为 = 当前行为。**

## 2. 任务

### 组 A · 扩表面（向后兼容，飞轮前置）

---

#### 任务 1 · 动画缓动 `ease`

**文件**：`src/engine/animations.ts`

**问题**。五个动画原语没有任何缓动。`emit-fall-fade` 的下落是 `positionY -= p * iod * distance`，`p` 线性——水是加速的，线性下落读作「贴纸在匀速下滑」。`float`/`pulse` 是纯 `sin`，`spin` 线性。所有东西都在做匀速运动。

**改动**。

给 `AnimationV2` 的每个变体加可选字段：

```ts
export type Ease = "linear" | "in" | "out" | "inout" | "gravity" | "bounce";
```

加一个映射函数：

```ts
/** 把 0..1 的线性进度映射成缓动后的进度。gravity = 自由落体（匀加速）。 */
function applyEase(p: number, ease: Ease = "linear"): number {
  switch (ease) {
    case "in":      return p * p;
    case "out":     return 1 - (1 - p) * (1 - p);
    case "inout":   return p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
    case "gravity": return p * p;               // 与 "in" 同曲线，语义不同，保留两个名字
    case "bounce":  return /* 标准 bounce-out */;
    default:        return p;
  }
}
```

作用点，逐个原语：

| 原语 | 把 ease 作用在哪 | 注意 |
|---|---|---|
| `emit-fall-fade` | **只作用于中段位移**（`positionY`、`outwardX`、`shrink` 用的那个 `p`） | 冒出段和淡出段的 `p` 保持线性，那两段是透明度渐变，加速会显得闪 |
| `fall` | 作用于 `progress` 后再算 `positionYAbsolute` | 透明度的淡入淡出仍用**原始** progress，否则头尾会不对称 |
| `float` | 作用于正弦的相位输入 | 可选，效果微妙，先接上不调 |
| `pulse` | 同上 | |
| `spin` | 作用于 `progress` | 匀速旋转是合理默认，但要允许非匀速 |

**向后兼容**：不写 `ease` 时全部走 `linear`，输出必须与改动前**逐位相同**。

**验收**：
- `npm run test:render` 全绿，goldens 未改动；
- 手写一个临时测试：同一份 `emit-fall-fade` 参数，`ease: "gravity"` 在 progress=0.5 处的位移 < `linear` 的位移（加速意味着前半段走得少）。

---

#### 任务 2 · 元素混合模式 `blend`

**文件**：`src/engine/types.ts`、`src/engine/element-renderer.ts`

**问题**。所有元素统一 `MeshBasicMaterial({ transparent: true })` 普通混合。`#62C3F2` 的不透明蓝色块盖在脸上——真实眼泪是折射的，颜色主要来自背后的皮肤。腮红更明显：现在是浮在脸前的一层雾，不是长在皮肤上的红。

**改动**。

`ElementV2` 加：

```ts
/** 与背景的混合方式。缺省 normal。multiply 让腮红贴到皮肤上，screen 让眼泪透出底色。 */
blend?: "normal" | "add" | "screen" | "multiply";
```

`element-renderer.ts / build()` 建材质时映射：

```ts
normal   → THREE.NormalBlending
add      → THREE.AdditiveBlending
screen   → 自定义（THREE.CustomBlending + OneMinusDstColor / One）
multiply → THREE.MultiplyBlending
```

`screen` three 没有内置常量，用 `CustomBlending` 配 `blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor`。

**坑**：`multiply` 与 `transparent: true` 同时开时，透明区域会把背景压黑。素材的透明区必须是**白色**而非黑色才正确。`gradient` 那条路是程序化画的，`transparentize()` 现在把终点色的 alpha 归零但保留 RGB——对 `multiply` 要改成趋近白色。给 `gradient` + `multiply` 的组合单独处理，别指望通用路径。

**向后兼容**：不写 `blend` 时走 `NormalBlending`，与现在一致。

`src/lib/validate.ts` 加白名单校验，非法值一次性列出可选项（沿用现有报错风格）。

**验收**：
- goldens 未改动、`test:render` 全绿；
- 临时加一个 `blend: "multiply"` 的 gradient 元素，肉眼确认它是压在皮肤上而不是浮在前面。验完删掉，**不要提交模板改动**。

---

#### 任务 3 · 生成器抖动 `jitter`

**文件**：`src/engine/generators.ts`、`src/lib/validate.ts`

**问题**。`crying.json` 的 trail 是 `count: 3, step: 0, decay: 1`——三滴眼泪起点相同、大小相同，只有相位差。它们沿同一条线单列前进，像流水线上的零件。

**改动**。

给 `trail` / `mirrorPair` / `ring` / `spread` 的 item 加可选：

```ts
jitter?: {
  /** 尺寸倍率的随机范围，如 0.2 表示 ±20% */
  size?: number;
  /** 归一化相位的随机偏移 */
  phase?: number;
  /** 位置偏移的随机量，单位 IOD，[x, y] */
  offset?: [number, number];
  /** 必填当且仅当用了 jitter。没有 seed 展开不确定，golden 对比无从建立 */
  seed: number;
};
```

复用文件里已有的 `mulberry32(seed)`，**不要引入 `Math.random()`**。每个展开出来的实例从同一个 rng 流里连续取值，顺序必须与展开顺序绑定，这样同一份 JSON 在任何机器上展开结果逐元素一致（`scatter` 已经立了这个规矩，照抄）。

`validate.ts`：用了 `jitter` 但没给 `seed` → 报错，措辞对齐 scatter 现有那条。

**向后兼容**：不写 `jitter` 时展开结果必须**逐元素相同**（包括 id 序列，别让 rng 的存在改变 id 分配顺序）。

**验收**：
- `npm run validate:templates` 全绿；
- 同一份带 jitter 的 JSON 展开两次，`JSON.stringify` 结果完全相同；
- goldens 未改动。

---

### 组 B · 粒子观感（零 golden 影响）

这三条改的都是 `src/engine/particles.ts`。粒子没有离线渲染覆盖，所以**验收只能靠肉眼 + 帧率**——这是本批唯一没有自动判据的部分，改完必须真机看一眼。

---

#### 任务 4 · 粒子深度分层

**问题**。`emit()` 里 size / speed 都是均匀随机，没有深度概念。所有雪花一样清晰、一样的速度分布、一样的亮度。真实的雪是分层的：近处大、糊、快，远处小、锐、慢。

**改动**。

加一个 `private readonly depth = new Float32Array(MAX)`。`emit()` 里 `depth[i] = Math.random()`（这里可以用 `Math.random()`——粒子不参与 golden；但如果将来要把粒子纳入 L2，这里得换成播种 rng，**写个 TODO 注明**）。

然后三处：

```
size[i]  *= lerp(0.5, 1.6, z)
speed    *= lerp(0.7, 1.3, z)      // 在算 vx/vy 之前作用
alpha    *= lerp(0.55, 1.0, z)     // step() 里最终 alpha 上再乘
```

**这一条是任务 6（粒子遮挡）的前置**——那条要用同一个 `z` 判定粒子在人前还是人后。所以字段名和取值范围现在就定死：`z ∈ [0,1]`，`0 = 最远`。

**验收**：肉眼能看出前后层次；帧率无明显变化（只多一个数组读）。

---

#### 任务 5 · twinkle 每粒独立频率

**问题**。`const a = fade * (0.55 + 0.45 * Math.sin(t * 7 + this.phase[i]))`——全场 7 rad/s 同频，只有相位不同。眼睛会认出这个周期，读作「整体在频闪」而不是「颗粒各自在闪」。

**改动**。`phase` 数组旁边加 `freq`，`emit()` 里 `freq[i] = 4 + Math.random() * 6`，`step()` 里 `Math.sin(t * this.freq[i] + this.phase[i])`。

**验收**：盯着看 10 秒，看不出统一节拍。

---

#### 任务 6 · 雪的混合模式

**问题**。`applySubstance()` 里 `blending = s.settle ? AdditiveBlending : NormalBlending`——雪走加法混合。白色加法叠在白墙、窗边、浅色沙发上**完全看不见**。在深色背景上很漂亮，到用户家里就没了。这类「在我这好看在你那不好看」的 bug 最难自测发现。

**改动**。雪改用 `NormalBlending`，并在 point 的 fragment shader 里给一圈极淡暗边，让白雪能在白墙上读出来：

```glsl
float d = length(gl_PointCoord - 0.5);
if (d > 0.5) discard;
float core = smoothstep(0.5, 0.0, d);
float rim  = smoothstep(0.5, 0.34, d) - core;   // 外沿一圈
vec3 c = mix(vC, vC * 0.55, rim * 0.6);         // 暗边
gl_FragColor = vec4(c, core * vA);
```

参数需要真机对着白墙调，上面是起点不是终点。

**注意**：`applySubstance` 里 `settle` 现在同时承担「是否堆积」和「用什么混合」两个语义。本条要把混合方式**提到 `Substance` 里作为独立字段** `blend?: "normal" | "add"`（缺省 normal），别继续复用 `settle`——那是两件事，耦着以后加"会堆积但要发光"的物质就表达不出来。这需要同步改 `types.ts` 和 `validate.ts`，并给 `golddust`（金粉，应该发光）显式写 `"blend": "add"`。

> ⚠️ 这是本批**唯一**需要动模板 JSON 的地方，只动 `golddust.json` 一个字段，且 golddust 没有 golden。除此之外仍然一行不许改。

**验收**：对着白墙拍，雪清晰可辨；金粉仍然发光。

---

### 组 C · 帧效果

---

#### 任务 7 · 修 `blur` 静默失效（这是 bug，不是功能）

**问题**。`validate.ts:541` 接受 `kind: "blur"` 并校验 `radius > 0`，但 `engine.ts / setupSourceEffect()` 第一行：

```ts
if (!source || source.effect.kind !== "pixelate") {
  // 回落到普通视频材质
```

于是声明了 `blur` 的模板**能过 L0 校验、能正常渲染、什么效果都没有、且不报任何错**。这是最糟的一类 bug：静默、且校验器给了它虚假的通过信号。

对飞轮尤其致命——LLM 完全可能生成 `blur` 模板，全套 gate 绿灯放行，产出一个"没效果"的模板。

**改动**。在同一个 `onBeforeCompile` 注入点里实现 `blur`。当前 shader 已经有 `gridUv` 那套结构，blur 就是把单点采样换成多次采样平均：

```glsl
// radius 归一化到长边，换算成 uv 步长；9 次采样够用，别做真高斯
vec4 blurTexel = vec4(0.0);
for (int i = -1; i <= 1; i++)
  for (int j = -1; j <= 1; j++)
    blurTexel += texture2D(map, vMapUv + vec2(float(i), float(j)) * uBlurStep);
blurTexel /= 9.0;
```

`DECODE_VIDEO_TEXTURE` 那段 sRGB 转换必须对 `blurTexel` **同样**补上——现有代码对 `sharpTexel` 和 `blockTexel` 都补了，漏一个就会出现"有效果的区域偏亮"，而且这个 bug 在图片源的离线 harness 上复现不出来（原注释里已经记过这个坑，照办）。

顺带把 `validate.ts:535` 那条「posterize / pixel-art 只留了接口没有实现」的报错里，把 `blur` 从"已实现"的隐含集合里说清楚——现在这条报错只挡了 posterize 和 pixel-art，等于默许了 blur。

**验收**：临时写一个 blur 模板跑 harness，截帧确认背景确实糊了；确认有效果区和无效果区的**颜色一致**（这是 sRGB 那个坑的判据）；验完删掉临时模板。

---

#### 任务 8 · 新增 `desaturate` 帧效果

**问题**。整个 overlay 类目只有马赛克一个 trick，所以只有一个模板。

**改动**。`types.ts` 的 `SourceEffect.effect` 联合里加：

```ts
| { kind: "desaturate"; amount: number }   // 0..1，1 = 全灰
```

shader 里五行：

```glsl
float g = dot(effectTexel.rgb, vec3(0.2126, 0.7152, 0.0722));
vec4 grayTexel = vec4(mix(effectTexel.rgb, vec3(g), uAmount), effectTexel.a);
```

同样注意 sRGB 解码要在**灰度化之前**做，否则亮度权重算在错误的色彩空间里，灰会偏。

`validate.ts` 加 `amount ∈ [0,1]` 校验并从"未实现"名单里移出。

**为什么选这个**：`apply: "outside"` + `desaturate` = 「**只有我是彩色的**」。比「只有我是高清的」传播性强得多，而实现成本是本批最低的之一。

**验收**：新建 `src/content/templates/colorful-me.json`，`npm run validate:templates` 通过，harness 截帧确认人是彩色的背景是灰的。

> 这是本批唯一允许**新增**模板文件的地方。新模板没有 golden，跑 L3 那套健壮性断言即可，不要为它生成 golden——留给下一批统一处理。

## 3. 收尾

### 验证命令

```bash
npm run validate:templates     # L0，必须绿
npm run test:render            # L2，必须绿，且 git status 显示 test/golden/ 无改动
git status test/golden/        # ← 这一条是总闸，有输出就是越界了
```

### 提交建议

按组分三个 commit，别混在一起：

```
feat(engine): 动画缓动 / 元素混合模式 / 生成器抖动   (任务 1-3)
feat(particles): 深度分层 / 独立闪烁频率 / 混合模式独立字段  (任务 4-6)
fix(engine): blur 帧效果静默失效 + 新增 desaturate   (任务 7-8)
```

组 C 那个 commit 前缀是 `fix` 不是 `feat`——任务 7 修的是已经在线上的静默 bug。

### 完成后要做但不在本批的

**下一个 commit**（单独做，因为它会作废 golden，需要人工过目）：把新能力用到现有模板上——`crying.json` 的 `emit-fall-fade` 加 `ease: "gravity"`、眼泪加 `blend: "screen"`、trail 加 `jitter`。这一步的 golden 重录是**预期内**的，和本批的"零作废"是两回事。

## 4. 明确不做

以下条目在 `EFFECT-QUALITY.md` 里，但**不属于本批**，看到相关代码也不要顺手改：

| 条目 | 为什么推迟 |
|---|---|
| P-1 粒子遮挡 | 需要把 `MaskField` 的生命周期从「帧效果专用」提升为「只要跑分割就维护」，是本轮唯一有结构风险的改动。单独一个 PR。 |
| P-2 累积缓冲（积雪/湿痕） | 引入跨帧累积状态，会破坏 `renderAt(t)` 的无历史性——harness 要从「跳到 t」改成「从 0 定步长积到 t」。设计要先解决这个再动手。 |
| P-6 圆点迁 instanced quad | 新渲染路径。 |
| F-3 face mesh 变形 | 新渲染路径，且需要新的校验层。单独立项。 |
| F-5 blendshape 驱动 | 要改 `outputFaceBlendshapes` 并重录 fixture，与 `PRODUCTION-TODO` §7 的矩阵重录合并做更划算。 |
| O-1 confidence mask | 要改 `MaskSink` 签名并重录 fixture，同上。 |
| PRODUCTION-TODO 全部 | 那是正确性，这是观感，两条线分开走。**唯一的硬依赖**：facetrack 的观感调参必须等 §1 坐标系修完，否则你在错的位置上调参。本批的任务 1/2/3 只改引擎能力不调参，所以不受这条约束。 |
