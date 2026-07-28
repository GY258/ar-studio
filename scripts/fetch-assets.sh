#!/usr/bin/env bash
# 把 MediaPipe 的 wasm 和分割模型拉到本地自托管（PRD 5.6）。
# 国内访问 storage.googleapis.com / jsdelivr 不稳定甚至不通，这一步不做产品在国内不可用。
set -euo pipefail

VERSION="0.10.14"
DEST="public/vendor"
SEG_URL="https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite"
FACE_URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"

mkdir -p "$DEST/wasm"

echo "→ 拉 tasks-vision@$VERSION 的 wasm"
TMP="$(mktemp -d)"
npm pack "@mediapipe/tasks-vision@$VERSION" --pack-destination "$TMP" >/dev/null
tar -xzf "$TMP"/*.tgz -C "$TMP"
cp "$TMP"/package/wasm/* "$DEST/wasm/"
rm -rf "$TMP"

echo "→ 拉分割模型"
curl -fSL "$SEG_URL" -o "$DEST/selfie_segmenter.tflite"

# 人脸模型以前漏了。crying / emotions 这类 facetrack 模板全靠它，
# 不拉的话即使配了另外两个变量，这些模板在国内照样打不开。
echo "→ 拉人脸模型"
curl -fSL "$FACE_URL" -o "$DEST/face_landmarker.task"

cat <<'TIP'

拉完了。在 .env.local 里指过去：

  NEXT_PUBLIC_WASM_BASE=/vendor/wasm
  NEXT_PUBLIC_SEG_MODEL=/vendor/selfie_segmenter.tflite
  NEXT_PUBLIC_FACE_MODEL=/vendor/face_landmarker.task

public/vendor 已经在 .gitignore 里 —— 这些是构建产物，不进仓库。
上线时上传到 R2 并把上面两个变量指向 CDN 域名。
TIP
