# 放到服务器上

按「最少要做多少事才能让人用上」排的。分三档，第一档做完就有一个能用的站。

---

## 第一档：最简版本（只上免费模板）

**能用**：主页、模板库、工作台、云朵落雪、录制、下载成片。
**不能用**：解锁付费模板——点了会明确告诉用户这个部署还没开支付，不是坏掉。

这一档**不需要数据库、不需要 Stripe、不需要 Google 登录**，一个环境变量都不用配。
在本地生产模式下实测过：所有页面 200，免费模板可用，付费模板 403，
埋点静默丢弃，服务端无异常。

M1 最小可交付定义里除了「付费解锁花洒」之外的每一环，这一档都覆盖了。

### 必须做的四件事

**1. HTTPS。** 不是安全洁癖，是 `getUserMedia` 在非安全上下文里直接不存在，
没有 HTTPS 就没有摄像头，产品为零。`localhost` 例外，所以本地开发不用管。

**2. 一个 Node ≥ 18.17 的运行环境。**

注意：**这个项目不能导出成静态文件扔进 nginx 目录。** 有 API 路由、有
`force-dynamic`、权益判断必须在服务端跑，所以要一个常驻的 node 进程。
`next export` 这条路走不通。

**3. 构建并起进程。**

```bash
npm ci
npm run build        # 注意别在 next dev 跑着的时候执行，见 README
npm start            # 默认 3000
```

进程守护随便挑：`pm2 start npm --name ar-studio -- start`，或者 systemd unit，
或者 Docker。没有特殊要求。

**4. 反代到 3000 并挂证书。** nginx + certbot 就行。要注意的只有一条：
`proxy_set_header Host $host` 之类的常规配置，以及别把 `/api/webhooks/stripe`
的 body 改写掉（那个之后接支付时要验签，需要原始 body）。

### 强烈建议顺手做的

**5. 自托管模型和 wasm。**

```bash
npm run assets
```

然后在环境变量里：

```
NEXT_PUBLIC_WASM_BASE=/vendor/wasm
NEXT_PUBLIC_SEG_MODEL=/vendor/selfie_segmenter.tflite
```

不做的后果：模型从 jsdelivr 和 storage.googleapis.com 拉，**国内用户大概率加载不出来**，
页面停在「Loading the person-segmentation model…」。而且这几 MB 走自己的 CDN 快很多。

**6. `NEXT_PUBLIC_SITE_URL=https://你的域名`**，之后 Stripe 回跳要用。

**7. `NEXTAUTH_SECRET=$(openssl rand -base64 32)`**，现在没有 provider 用不到，
但有人手动访问 `/api/auth/signin` 时不至于报错。

---

## 第二档：接数据库（做付费之前的前提）

四条命令：

```bash
# 1. 建库。Neon / Supabase 免费档最省事，拿到连接串就行
export DATABASE_URL='postgres://...'

# 2. 建表
npm run db:migrate

# 3. 把模板灌进 templates 表 —— 这一步不做，权益会静默发不出去（见下）
npm run db:seed

# 4. 把整条数据层链路真跑一遍
npm run db:check
```

`db:check` 会验：建表、模板已灌、用户 upsert、订单落库+幂等、发权益、
不存在的 slug 影响 0 行、查权益、按 payment_intent 反查、退款回收、
Stripe 事件幂等、埋点写入。跑完自己清掉测试数据。

**这些 SQL 目前是「写完但没跑过」**——本机没有 Postgres 也没有 Docker，
所以我没法验证。`db:check` 就是为了让验证在你拿到连接串的那一刻变成一条命令。
它报绿之前，别接支付。

### 为什么 db:seed 是必需的，不是可选的

`entitlements.template_id` 和 `orders.template_id` 都是指向 `templates.id` 的外键。
模板本身从仓库的 JSON 读，`templates` 表默认是空的。发权益的语句是：

```sql
INSERT INTO entitlements (...) SELECT $1, t.id, ... FROM templates t WHERE t.slug = $2
```

空表 → 插 0 行 → **不报错**。表现是支付成功、webhook 返回 200、权益没发。
代码里现在会在影响 0 行时抛错并提示跑 `db:seed`，但表还是得灌。

改了模板 JSON 之后重跑一次 `db:seed`，幂等，可以反复跑。

## 第三档：登录 + 支付

顺序不能反：**Stripe 依赖登录**，因为退款回收权益和跨设备可用都需要一个稳定的 user id。

**登录**

1. Google Cloud Console 建 OAuth 客户端，回调填 `https://域名/api/auth/callback/google`
2. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `NEXTAUTH_URL`

**支付**

1. `STRIPE_SECRET_KEY`（先用 test key）
2. Stripe 后台加 webhook endpoint 指向 `https://域名/api/webhooks/stripe`，
   订阅 `checkout.session.completed`、`charge.refunded`、`charge.dispute.created`
3. `STRIPE_WEBHOOK_SECRET`
4. **用 test key 走通一次完整流程**：点解锁 → 跳 Checkout → 付款 → 回跳 → 确认权益到账 → 确认刷新后仍在

代码写完了但**从来没用真实 key 跑过**，验签、幂等、退款回收三条都是未验证状态。
这是整个仓库里唯一一条「代码完整但零验证」的关键路径。

---

## 两种托管方式

**Vercel**：`git push` 就部署，HTTPS 和 CDN 自动。第一档基本等于零运维。
需要在浏览器里 Import Project——注意 Vercel CLI 在做 TLS 拦截的公司网络下连不上
（Node 不读系统钥匙串，证书验不过），浏览器和 `git` 没这个问题。

**自有服务器**：Docker Compose 跑 Next + Postgres，nginx 反代，certbot 签证书，
Cloudflare 挡前面做 CDN 和 DDoS。多出来的是运维成本，换来的是数据和资源都在自己手里。

---

## 上线后必须真机测的三件

这三条只有真机能回答，桌面 Chrome 测不出来（iOS 上所有浏览器内核都是 WebKit）：

1. **iOS Safari 能不能录出 mp4。** 录制按钮上写着实际拿到的容器格式。
   这条不通，产品对 Reels 创作者就不成立。
2. **移动端帧率。** 引擎有降级（640×360、粒子减半、关溅射），触发条件是
   `pointer: coarse`，这个启发式很粗糙，需要按真实机型调。
3. **微信内置浏览器。** iOS 微信的 `getUserMedia` 限制多，现在既没检测也没引导。
