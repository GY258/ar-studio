<!-- 由 npm run gen:skill-reference 从源码生成，不要手改 -->

# 模板示例

这些是仓库里真实跑着的模板，照着改比从零写快。

## crying

```json
{
  "slug": "crying",
  "name": { "zh": "哭哭脸", "en": "(T_T) Crying" },
  "category": "face",
  "sort_order": 60,
  "price_cents": 0,
  "schema_version": 2,
  "template_type": "facetrack",
  "perception": ["face"],
  "preview": {},
  "elements": [
    {
      "generate": "mirrorPair",
      "anchor": "lower_eyelid",
      "offset": [0, 0.0754],
      "item": {
        "asset": { "kind": "svg-lib", "key": "tear-streak" },
        "size": { "ref": "iod", "scale": 0.28 },
        "animations": [{ "preset": "pulse", "scaleRange": [0.97, 1.03], "period": 2.0 }]
      },
      "children": [
        {
          "generate": "trail",
          "count": 3,
          "step": 0,
          "decay": 1,
          "phaseShift": 0.9,
          "item": {
            "asset": { "kind": "svg-lib", "key": "tear-drop" },
            "size": { "ref": "iod", "scale": 0.16 },
            "animations": [{ "preset": "emit-fall-fade", "distance": 1.2, "period": 2.8 }]
          }
        }
      ]
    },
    {
      "id": "tt-text",
      "asset": {
        "kind": "text",
        "text": "(T_T)",
        "color": "#FFFFFF",
        "fontWeight": 700,
        "shadow": "0 2 5 rgba(0,0,0,.35)"
      },
      "anchor": { "space": "screen", "nx": 0.5, "ny": 0.92 },
      "size": { "ref": "vw", "scale": 0.07 }
    }
  ]
}
```

## lowres-life

```json
{
  "slug": "lowres-life",
  "name": { "zh": "只有我是高清的", "en": "Only I Am HD" },
  "category": "fun",
  "sort_order": 90,
  "price_cents": 0,
  "schema_version": 2,
  "template_type": "overlay",
  "perception": ["segmentation"],
  "preview": {},
  "source": {
    "mask": { "provider": "person", "feather": 0.015, "onLost": "clear" },
    "apply": "outside",
    "effect": { "kind": "pixelate", "blocks": 56 }
  },
  "elements": [
    {
      "id": "menu",
      "asset": { "kind": "svg-lib", "key": "quality-menu" },
      "anchor": { "space": "screen", "nx": 0.74, "ny": 0.76 },
      "size": { "ref": "vw", "scale": 0.44 }
    },
    {
      "id": "cursor",
      "asset": { "kind": "svg-lib", "key": "cursor-hand" },
      "anchor": { "space": "screen", "nx": 0.86, "ny": 0.735 },
      "size": { "ref": "vw", "scale": 0.075 },
      "animations": [{ "preset": "float", "amplitude": 0.004, "period": 3.0 }]
    }
  ]
}
```

## emotions

```json
{
  "slug": "emotions",
  "name": { "zh": "情绪文件夹", "en": "Emotion Folders" },
  "category": "face",
  "sort_order": 50,
  "price_cents": 0,
  "template_type": "facetrack",
  "preview": {},
  "face_track_elements": [
    { "id": "f-l1", "type": "sticker", "svgAsset": "folder", "landmark": "nose_bridge", "offsetX": -0.35, "offsetY": 0.30, "iodScale": 0.25, "aspect": 0.821, "float": { "amplitude": 0.012, "period": 3.2 } },
    { "id": "f-r1", "type": "sticker", "svgAsset": "folder", "landmark": "nose_bridge", "offsetX": 0.35,  "offsetY": 0.30, "iodScale": 0.25, "aspect": 0.821, "float": { "amplitude": 0.012, "period": 3.5 } },
    { "id": "f-l2", "type": "sticker", "svgAsset": "folder", "landmark": "nose_bridge", "offsetX": -0.45, "offsetY": 0.80, "iodScale": 0.25, "aspect": 0.821, "float": { "amplitude": 0.012, "period": 3.8 } },
    { "id": "f-r2", "type": "sticker", "svgAsset": "folder", "landmark": "nose_bridge", "offsetX": 0.45,  "offsetY": 0.80, "iodScale": 0.25, "aspect": 0.821, "float": { "amplitude": 0.012, "period": 3.1 } },
    { "id": "f-l3", "type": "sticker", "svgAsset": "folder", "landmark": "nose_bridge", "offsetX": -0.55, "offsetY": 1.30, "iodScale": 0.25, "aspect": 0.821, "float": { "amplitude": 0.012, "period": 3.6 } },
    { "id": "f-r3", "type": "sticker", "svgAsset": "folder", "landmark": "nose_bridge", "offsetX": 0.55,  "offsetY": 1.30, "iodScale": 0.25, "aspect": 0.821, "float": { "amplitude": 0.012, "period": 3.3 } },
    { "id": "f-l4", "type": "sticker", "svgAsset": "folder", "landmark": "nose_bridge", "offsetX": -0.65, "offsetY": 1.80, "iodScale": 0.25, "aspect": 0.821, "float": { "amplitude": 0.012, "period": 3.9 } },
    { "id": "f-r4", "type": "sticker", "svgAsset": "folder", "landmark": "nose_bridge", "offsetX": 0.65,  "offsetY": 1.80, "iodScale": 0.25, "aspect": 0.821, "float": { "amplitude": 0.012, "period": 3.4 } },
    { "id": "f-l5", "type": "sticker", "svgAsset": "folder", "landmark": "nose_bridge", "offsetX": -0.75, "offsetY": 2.30, "iodScale": 0.25, "aspect": 0.821, "float": { "amplitude": 0.012, "period": 3.7 } },
    { "id": "f-r5", "type": "sticker", "svgAsset": "folder", "landmark": "nose_bridge", "offsetX": 0.75,  "offsetY": 2.30, "iodScale": 0.25, "aspect": 0.821, "float": { "amplitude": 0.012, "period": 3.0 } },

    { "id": "t-l1", "type": "sticker", "text": "Fear",      "landmark": "nose_bridge", "offsetX": -0.35, "offsetY": 0.52, "iodScale": 0.15, "fontSizeW": 0.022, "fontWeight": 600, "color": "#FFFFFF", "shadow": "0 1 3 rgba(0,0,0,.45)" },
    { "id": "t-r1", "type": "sticker", "text": "Happy",     "landmark": "nose_bridge", "offsetX": 0.35,  "offsetY": 0.52, "iodScale": 0.15, "fontSizeW": 0.022, "fontWeight": 600, "color": "#FFFFFF", "shadow": "0 1 3 rgba(0,0,0,.45)" },
    { "id": "t-l2", "type": "sticker", "text": "Delighted", "landmark": "nose_bridge", "offsetX": -0.45, "offsetY": 1.02, "iodScale": 0.15, "fontSizeW": 0.022, "fontWeight": 600, "color": "#FFFFFF", "shadow": "0 1 3 rgba(0,0,0,.45)" },
    { "id": "t-r2", "type": "sticker", "text": "Sad",       "landmark": "nose_bridge", "offsetX": 0.45,  "offsetY": 1.02, "iodScale": 0.15, "fontSizeW": 0.022, "fontWeight": 600, "color": "#FFFFFF", "shadow": "0 1 3 rgba(0,0,0,.45)" },
    { "id": "t-l3", "type": "sticker", "text": "Painful",   "landmark": "nose_bridge", "offsetX": -0.55, "offsetY": 1.52, "iodScale": 0.15, "fontSizeW": 0.022, "fontWeight": 600, "color": "#FFFFFF", "shadow": "0 1 3 rgba(0,0,0,.45)" },
    { "id": "t-r3", "type": "sticker", "text": "Get angry", "landmark": "nose_bridge", "offsetX": 0.55,  "offsetY": 1.52, "iodScale": 0.15, "fontSizeW": 0.022, "fontWeight": 600, "color": "#FFFFFF", "shadow": "0 1 3 rgba(0,0,0,.45)" },
    { "id": "t-l4", "type": "sticker", "text": "Weary",     "landmark": "nose_bridge", "offsetX": -0.65, "offsetY": 2.02, "iodScale": 0.15, "fontSizeW": 0.022, "fontWeight": 600, "color": "#FFFFFF", "shadow": "0 1 3 rgba(0,0,0,.45)" },
    { "id": "t-r4", "type": "sticker", "text": "Laugh",     "landmark": "nose_bridge", "offsetX": 0.65,  "offsetY": 2.02, "iodScale": 0.15, "fontSizeW": 0.022, "fontWeight": 600, "color": "#FFFFFF", "shadow": "0 1 3 rgba(0,0,0,.45)" },
    { "id": "t-l5", "type": "sticker", "text": "Worried",   "landmark": "nose_bridge", "offsetX": -0.75, "offsetY": 2.52, "iodScale": 0.15, "fontSizeW": 0.022, "fontWeight": 600, "color": "#FFFFFF", "shadow": "0 1 3 rgba(0,0,0,.45)" },
    { "id": "t-r5", "type": "sticker", "text": "Enjoy",     "landmark": "nose_bridge", "offsetX": 0.75,  "offsetY": 2.52, "iodScale": 0.15, "fontSizeW": 0.022, "fontWeight": 600, "color": "#FFFFFF", "shadow": "0 1 3 rgba(0,0,0,.45)" }
  ]
}
```
