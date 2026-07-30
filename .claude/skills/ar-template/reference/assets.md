<!-- 由 npm run gen:skill-reference 从源码生成，不要手改 -->

# SVG 素材清单

素材放在 `src/content/assets/`，构建时打包成字符串常量。
高宽比（高/宽）从 viewBox 自动解析，**不要在 JSON 里手填 aspect**——这个字段已经删了。

| key | viewBox | 高/宽 |
|---|---|---|
| `crayon-drop` | 0 0 120 170 | 1.417 |
| `crayon-drop-solid` | 0 0 120 170 | 1.417 |
| `cursor-hand` | 0 0 32 32 | 1.000 |
| `emoji-blossom` | 0 0 36 36 | 1.000 |
| `emoji-cherry-blossom` | 0 0 36 36 | 1.000 |
| `emoji-gem` | 0 0 36 36 | 1.000 |
| `emoji-leaf` | 0 0 36 36 | 1.000 |
| `emoji-lotus` | 0 0 36 36 | 1.000 |
| `emoji-mushroom` | 0 0 36 36 | 1.000 |
| `emoji-rose` | 0 0 36 36 | 1.000 |
| `emoji-sparkles` | 0 0 36 36 | 1.000 |
| `emoji-sunflower` | 0 0 36 36 | 1.000 |
| `emoji-tulip` | 0 0 36 36 | 1.000 |
| `folder` | 0 0 112 92 | 0.821 |
| `quality-menu` | 0 0 340 300 | 0.882 |
| `tear-drop` | 0 0 24 34 | 1.417 |
| `tear-splash` | 0 0 96 40 | 0.417 |
| `tear-streak` | 0 0 52 28 | 0.538 |

用法：`"asset": { "kind": "svg-lib", "key": "tear-drop" }`

清单里没有想要的东西时，按这个顺序找：
1. 换个近似的 key 凑合（大部分「换个形状」的需求其实是换颜色）
2. 写 `{ "kind": "svg-inline", "svg": "<svg viewBox=...>...</svg>" }`，必须带 viewBox
3. 都不行才新增文件到 `src/content/assets/<key>.svg`，然后重新跑 `npm run gen:skill-reference`，
   否则清单里没有你的新 key，后续会话找不到它
