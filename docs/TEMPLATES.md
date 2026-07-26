# 怎么加一个模板

模板库靠持续扩充撑增长（PRD 1.3），所以加模板的成本必须低。这篇写清三件事：
怎么加、能调什么、什么时候不得不改引擎。

---

## 最短路径

在 `src/content/templates/` 扔一个 `.json`。就这样。

- 不用改任何代码，不用加 import
- dev 环境下刷新页面就能看到，不用重启
- 校验不通过会在加载时直接抛错，把每个问题和改法列出来

抄一个现成的改最快：`cloud.json` 是雪（会堆积），`shower.json` 是水（会溅开滑走），
`golddust.json` 是一个「只加 JSON 就多出两个新滑块」的示范。

---

## 三层扩展成本

写模板之前先确认你的想法落在哪一层。

### 第一层：只改 JSON —— 参数和滑块

物质的所有数值、道具的出口位置、暴露给用户的滑块，全都是 JSON。
**包括引擎从来不认识的新滑块**，只要它绑到某个已有参数上。

```jsonc
{
  "key": "grain",                    // 任意标识
  "label": { "zh": "颗粒", "en": "Grain size" },
  "min": 40, "max": 220, "default": 100, "step": 10,
  "target": "substance.size",        // 调什么
  "mode": "scale"                    // 滑块值当百分比乘上去，100 = 模板原值
}
```

`target` 可选值：

| target | 含义 |
|---|---|
| `rate` | 每秒发射多少粒子 |
| `wind` | 横向风的目标速度 |
| `stick` | 黏附强度，乘到 `substance.friction` 上 |
| `substance.gravity` | 重力 |
| `substance.friction` | 碰撞摩擦 |
| `substance.streak` | 拉伸系数。0 = 圆点，>0 = 液体 |
| `substance.size` | 粒子半径范围 |
| `substance.speed` | 初速范围 |
| `substance.spread` | 出射角散布 |
| `substance.splash` | 溅射数量 |

`key` 正好是 `rate` / `wind` / `stick` 时可以省略 `target`，走内置语义。
其他任何 key **必须**写 `target`，否则校验器会拦下来——不拦的话表现是
界面上滑块好好地在那儿、拖动毫无反应，这种问题极难排查。

`mode` 是 `scale`（默认，百分比）或 `absolute`（直接赋值）。
`size` / `speed` 是两端的区间：`scale` 时两端一起缩放，`absolute` 时两端都设成这个值。

### 第二层：给一张图 —— 新道具外观

道具外观有两种来源：

```jsonc
"emitter": { "shape": "cloud" }              // 内置程序化道具，代码里画的
"emitter": { "asset": "/t/watering-can.webp" }  // 一张图，不用改代码
```

内置的只有 `cloud` / `shower` / `glass` / `cup` 四个。**想要新外观，给 `asset` 一张
带透明通道的 webp 就行，仍然属于「不改代码」**。放 `public/t/` 下面。

配三个数：

- `aspect`：高 / 宽
- `port`：出口相对道具中心的位置，单位是道具自身的宽和高，y 向下为正
- `band`：出口横向铺开的宽度，单位是道具宽度。花洒要铺满喷头面（0.55），细水流接近 0

`port` 找起来有点烦，办法是先随便填，打开工作台看粒子从哪儿冒出来再调。
倾倒类道具还要给 `tilt`（弧度，正 = 向右），让初速朝杯口方向甩出去。

### 第三层：必须改引擎

这些做不到只改 JSON：

| 想做的事 | 要动什么 |
|---|---|
| 贴脸道具、手势触发 | `perception` 加 `face` / `hands`，引擎里接对应的 MediaPipe task |
| 特效跑到人身后 | 加一个只写深度的人像遮罩平面 |
| 积雪真的越堆越厚 | 加积雪深度场，见 `docs/prototypes/README.md` |
| 新的渲染方式（比如带旋转的花瓣） | 粒子系统加一种绘制模式 |

**碰到第三层时的原则：扩 schema，不要在引擎里写 `if (slug === "...")`。**
加「莲蓬头」和加「咖啡杯」对代码必须是同一件事，一旦开了按 slug 分支的头，
模板系统就退化成一堆写死的特效，增长逻辑也就断了。

---

## 字段速查

```jsonc
{
  "slug": "golddust",                  // 小写字母 / 数字 / 连字符，会进 URL
  "name": { "zh": "金粉", "en": "Gold Dust" },
  "category": "snow",                  // 归类，目前只用于展示
  "sort_order": 15,                    // 小的排前面。省略按 999 算
  "price_cents": 99,                   // 0 = 免费
  "preview": { "shape": "cloud" },     // 卡片预览。将来换成 poster / video
  "perception": ["segmentation"],      // 需要哪些模型。首期只有分割

  "emitter": {
    "shape": "cloud",                  // 或 "asset": "/t/xxx.webp"
    "aspect": 0.42,
    "port": { "x": 0, "y": 0.3 },
    "band": 0.5,
    "tilt": 0,
    "draggable": true,
    "default": { "x": 0, "y": 0.34 }   // 归一化屏幕坐标，(0,0) 是画面中心
  },

  "substance": {
    "gravity": -300,                   // 负值向下
    "friction": 0.6,                   // 0~1，越大越黏
    "streak": 0,                       // 0 = 圆点，>0 = 沿速度拉伸的液体
    "color": [1, 0.82, 0.42],          // 线性色 0~1
    "size": [1.6, 4.5],                // 半径范围，世界像素
    "speed": [50, 150],                // 初速范围
    "spread": 1.1,                     // 出射角散布，弧度
    "splash": 0,                       // 撞击后溅几滴
    "settle": true,                    // 撞上后停留堆积
    "twinkle": true                    // 闪烁。雪和金粉要，液体不要
  },

  "controls": [ /* 2~4 个滑块，见第一层 */ ]
}
```

---

## 调参手感

几个从原型阶段试出来的数量级，省得从零猜：

**雪** 重力 -560、摩擦 0.45、`settle: true`、`twinkle: true`、终速靠 `speed` 上限控。
雪要慢，快了就是雨。

**水** 重力 -1750、摩擦 0.05、`streak: 0.04`、`splash: 3`、`settle: false`。
摩擦必须接近 0，水的特征是撞上就滑走，不是停住。

**稠一点的液体（咖啡）** 重力 -1480、摩擦 0.13、`streak: 0.034`、`splash: 2`。

**颜色偏暗的液体**引擎会自动降高光（`color[0] < 0.5` 时把 gloss 从 0.85 降到 0.28），
不然棕色液体会反出白光，看着像发光的线。

---

## 校验

模板在加载时校验，不通过就抛 `TemplateError`，一次列出所有问题。
所以：

- dev 环境下打开任意页面就会看到错误
- `npm run build:check` 也会因此失败——**这就是模板的检查命令**，
  没有单独的 lint 脚本
- 部署时如果 `src/content/templates` 没被打进产物，会抛「一个模板都没有」
  而不是静默返回空清单（后者会让人以为是网站坏了，排查方向全错）

---

## 上线之后（M2）

现在模板是从仓库里的 JSON 读的，所以加模板还是要发一次版。
要做到 PRD 4.6 说的「新增模板不发版」，把 `src/lib/templates.ts` 里的 `loadAll()`
换成查 `templates` 表的 `config_json` 就行——**只换这一个文件**，
API、引擎、校验器都不用动。校验器那时候正好用在后台上传模板的入口上。
