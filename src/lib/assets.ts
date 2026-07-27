/**
 * 模型和 wasm 的位置。
 *
 * PRD 5.6：必须自托管。现在默认值还指着 jsdelivr 和 storage.googleapis.com，
 * 是为了 clone 下来不做任何准备就能跑。上线前跑 `npm run assets` 把文件拉到
 * public/vendor，然后在 .env.local 里指过去：
 *
 *   NEXT_PUBLIC_WASM_BASE=/vendor/wasm
 *   NEXT_PUBLIC_SEG_MODEL=/vendor/selfie_segmenter.tflite
 *
 * 国内访问不稳定甚至不通，这两行不改，产品在国内等于不可用。
 */

export const WASM_BASE =
  process.env.NEXT_PUBLIC_WASM_BASE || "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

export const SEG_MODEL =
  process.env.NEXT_PUBLIC_SEG_MODEL ||
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite";

export const FACE_MODEL =
  process.env.NEXT_PUBLIC_FACE_MODEL ||
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

export const SELF_HOSTED = WASM_BASE.startsWith("/");
