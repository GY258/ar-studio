# 素材来源与授权

## emoji-*.svg

来自 [Twemoji](https://github.com/twitter/twemoji) v14.0.2（Twitter / X 的 emoji 图形）。

- 图形授权：**CC-BY 4.0** —— 可自由使用和修改，**必须署名**。本文件即署名。
- 代码授权（不适用于这里，只用了图形）：MIT

### 为什么不直接用 `kind: "text"` 写 emoji 字符

那样走的是**系统** emoji 字体：macOS 落到 Apple Color Emoji，Linux CI 落到
Noto Color Emoji，字形完全不同 —— golden 又变成只在录它的那台机器上成立，
正是 `src/engine/text-font.ts` 那次要解决的问题。

内嵌字体在这里救不了：一份彩色 emoji 字体十几 MB，不可能塞进 bundle。
做成 `svg-lib` 素材是唯一既确定又不臃肿的路，十个加起来约 13KB。

用法和其他素材一样：`{ "kind": "svg-lib", "key": "emoji-sunflower" }`

### 加新 emoji

```bash
curl -sL "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/<码点>.svg" \
  -o src/content/assets/emoji-<名字>.svg
# 再把内容加进 src/engine/svg-assets.ts 的 SVG_LIB（两处都要加，见 SKILL.md）
npm run gen:skill-reference
```

码点查表：<https://unicode.org/emoji/charts/full-emoji-list.html>（去掉 `U+`，小写）。

## 其他 svg

`tear-*` / `crayon-*` / `folder` / `quality-menu` / `cursor-hand` 是本仓库手写的，
无第三方授权。
