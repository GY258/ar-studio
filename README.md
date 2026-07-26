# AR Studio

浏览器里的 AR 相机滤镜。选一个模板，对着摄像头拍，直接下载成片。

对应 `PRD-AR-Studio.md` v1.0 的 M1 范围。这个仓库是**骨架 + 可运行的引擎**，不是完成的 M1——下面「已经是真的」和「还是桩」两节写清楚了边界。

---

## 跑起来

```bash
npm install
npm run dev            # http://localhost:3000
```

校验用的构建走 `npm run build:check`（写到 `.next-build`）。**不要在 `next dev` 跑着的时候执行 `npm run build`**——两者共用 `.next`，生产产物会盖掉 dev 的 chunk，dev server 当场 `MODULE_NOT_FOUND`，看起来像代码坏了，其实只是产物被覆盖。踩过一次。

零配置即可运行：没有 `DATABASE_URL` 就用进程内内存态，没有 Stripe key 就走体验模式（点解锁直接发权益）。目的是 clone 下来立刻能走通「选模板 → 开摄像头 → 录制 → 下载 → 解锁付费模板」整条链路。

摄像头需要安全上下文。`localhost` 算安全上下文，直接开发没问题；部署必须 HTTPS，这不是可选项。

### 自托管模型（上线前必做）

```bash
npm run assets
```

把 MediaPipe 的 wasm 和分割模型拉到 `public/vendor`，然后在 `.env.local` 里指过去：

```
NEXT_PUBLIC_WASM_BASE=/vendor/wasm
NEXT_PUBLIC_SEG_MODEL=/vendor/selfie_segmenter.tflite
```

默认值指向 jsdelivr 和 storage.googleapis.com，**国内访问不稳定甚至不通**。不改这两行，产品在国内等于不可用。上线时把这些文件传到 R2，变量指向 CDN 域名。

---

## 已经是真的

| 部分 | 状态 |
|---|---|
| 渲染引擎 | 完整。分割 → 占据场 → 粒子碰撞 → 合成，见 `src/engine/` |
| 模板 schema | 完整。5 个模板全部由 `src/content/templates/*.json` 驱动，引擎不认 slug。**目录里扔一个 JSON 就是一个新模板**，不改代码、dev 下不用重启。滑块可以绑到任意物质参数上，加新滑块也不用改引擎。见 `docs/TEMPLATES.md` |
| 模板校验 | 完整。加载时校验，一次列出所有问题和改法；配置没打进产物时抛错而不是静默返回空清单 |
| 服务端权益校验 | 完整且已验证。付费模板未解锁时 `/api/templates/:slug/config` 返回 403，不下发任何物理参数 |
| 录制 | 完整。mp4 优先，降级 webm 时 UI 明确提示该格式部分平台无法直传 |
| 麦克风 | 完整，默认关闭 |
| 道具拖动 | 完整。花洒必须能对准头顶，否则功能不成立 |
| 参数滑块 | 完整。由模板配置定义，切模板时同名参数保留 |
| Stripe Checkout + Webhook | 代码完整（验签 + 幂等 + 退款回收），但**没有用真实 key 跑过** |
| 主页 / 模板库 / 工作台 / 法务页 | 有，按 PRD 第 6 章的 token 落的 |
| 数据库 schema | `db/schema.sql`，**没有跑过迁移** |

## 还是桩

- **Google 登录**：`next-auth` 配好了，没有 `GOOGLE_CLIENT_ID` 时不注册 provider，登录入口点了会跳到 NextAuth 的空页面。
- **`/account` 用户中心、`/admin` 后台**：完全没做（PRD 里是 P1）。
- **删除账号**：`DELETE /api/me` 返回 501。GDPR 要求的级联清理没写。
- **模板从数据库读**：现在从仓库里的 JSON 读，所以加模板仍然要发一次版。要做到 PRD 4.6 说的「新增模板不发版」，得把 `src/lib/templates.ts` 的 `loadAll()` 换成查 `templates` 表——换的只有这个文件，校验器可以直接复用在后台上传入口上。
- **模板预览图**：用程序化画的道具凑数。真实的 4:5 效果视频没有，`preview.poster/video` 字段留好了。
- **主页 Hero 视频**：没有。现在是纯排版。
- **i18n**：界面是英文，所有字符串收口在 `src/lib/copy.ts`，模板名和滑块名走 schema 里的 `{zh, en}`。但没有语言切换器，中文版是否要做见 PRD 11.4。
- **埋点**：事件会落库，但没有接 PostHog，也没有漏斗看板。
- **Cookie 同意横幅**：没做。上 PostHog 之前必须补。

---

## 结构

```
src/
├─ engine/          与框架无关，可以单独拿去用
│  ├─ types.ts      模板 schema。改这里等于改产品能力边界
│  ├─ occupancy.ts  人像遮罩 → 占据场
│  ├─ particles.ts  粒子池 + 碰撞 + 两种渲染
│  ├─ props.ts      程序化道具贴图
│  ├─ engine.ts     管线编排
│  └─ recorder.ts   录制
├─ content/templates/*.json   5 个模板，加一个文件就是加一个模板
│  └─ ../engine/resolve.ts    滑块 → 参数的解算，引擎因此不认识任何具体滑块
├─ lib/             服务端：模板、权益、认证、支付、数据
├─ app/api/         API 路由
└─ components/      工作台 UI
```

---

## 几个不做就会翻车的地方

这些是原型阶段踩出来的，写在这里免得后面有人「优化」掉：

**遮罩必须时间平滑（α≈0.45）再用。** 单帧分割会闪，直接用会让粒子抽搐。

**遮罩必须模糊后再求梯度。** 硬边 0/1 求出的法线逐格跳变，粒子沿人体边缘会抖。模糊之后边缘有坡度，差分才是平滑的表面法线。

**镜像有两处，改一个必须改另一个。** 背景平面 `scale.x = -1`，占据场采样 `u = 0.5 - x/W`。只改一处的话人和特效会反向。

**液体不能用 `LineSegments` 画。** WebGL 里 `gl.lineWidth` 在 Chrome/ANGLE 上恒等于 1 设备像素，2x 屏上是半个 CSS 像素的头发丝，调什么参数都救不回来。现在用的是沿速度方向拉伸的 instanced 胶囊。

**`gl_PointSize` 的单位是设备像素。** 不乘 dpr 的话 2x 屏上粒子直接小一半。

**倾倒类道具的杯口必须真的朝下。** 倾角要到 120° 上下；35° 那种「歪着的杯子」倒不出水，看着就是错的。

**模板目录必须显式声明进部署产物。** 模板是运行时 `fs` 读的，webpack 追踪不到，`next.config.mjs` 里的 `outputFileTracingIncludes` 少了那一条，线上就是零个模板。

**数据库检查不能放在模块顶层。** `next build` 期间 `NODE_ENV` 已经是 production，构建机上没有 `DATABASE_URL`，顶层 throw 会直接把构建炸掉。

---

## 部署

方案 A（推荐）：Vercel + Neon + R2。

**先跑通链路再配环境。** 零环境变量部署上去是可用的，已经在生产模式下验证过：
主页 / 模板库 / 工作台 200，免费模板能用，付费模板 403，埋点静默丢弃不报错，
点解锁会明确告诉用户这个部署还没开支付。也就是说第一次部署就能验证
「HTTPS + 摄像头 + 录制」这条主链路，不用先把 Stripe 和数据库配好。

配环境变量的顺序建议：`NEXT_PUBLIC_*` 资源路径 → `DATABASE_URL` → Google → Stripe。
方案 B：Docker Compose 跑 Next + Postgres，Nginx 反代，Cloudflare 挡前面。

两个方案共同的硬要求：HTTPS、静态资源走 CDN 配长缓存、环境变量走密钥管理不进仓库。

环境变量见 `.env.example`。

---

## 上线前必须真机实测的

PRD 7.2 把 iOS Safari 标成最大风险，这个判断是对的。具体要测：

1. **iOS Safari 能不能录出 mp4。** `MediaRecorder` 的实现各家不同，代码里已经把实际选中的容器暴露出来了，但没有真机验证过。这一条不通，产品不成立。
2. **移动端帧率。** 引擎有降级（分辨率 640×360、粒子减半、关溅射），触发条件是 `pointer: coarse`，这个启发式很粗糙，需要按真实机型调。
3. **微信内置浏览器。** iOS 微信的 `getUserMedia` 限制多，现在没有检测和引导。
