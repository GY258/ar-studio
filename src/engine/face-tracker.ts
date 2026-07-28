/**
 * 人脸追踪：landmark 检测 + 每帧的人脸度量。
 *
 * 检测能力藏在 LandmarkProvider 后面，因为离线验证要能在没有摄像头、没有 GPU、
 * 没有外网的条件下回放录好的 landmark。CI 里永远不跑 MediaPipe——
 * 模型走 jsdelivr，国内不通，CI 同样不通。
 */

import { FilesetResolver, FaceLandmarker, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { WASM_BASE, FACE_MODEL } from "@/lib/assets";
import { resolveLandmark } from "./anchors";

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/** 引擎能吃的画面源。测试用静态图，线上用摄像头 video。 */
export type FrameSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

export interface LandmarkProvider {
  /** 返回本帧的 478 点；检测不到返回 null（调用方保留上一帧）。 */
  detect(source: FrameSource, nowMs: number): Landmark[] | null;
  close?(): void;
}

/** 线上实现。 */
export class MediaPipeLandmarkProvider implements LandmarkProvider {
  private landmarker: FaceLandmarker | null = null;
  private loading = false;

  async load(): Promise<void> {
    if (this.landmarker || this.loading) return;
    this.loading = true;
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: false,
      });
    } finally {
      this.loading = false;
    }
  }

  detect(source: FrameSource, nowMs: number): Landmark[] | null {
    if (!this.landmarker) return null;
    try {
      const r: FaceLandmarkerResult = this.landmarker.detectForVideo(source as HTMLVideoElement, nowMs);
      return r.faceLandmarks?.[0] ?? null;
    } catch {
      return null; // 丢一帧比炸掉整个循环好
    }
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

/** 测试实现：回放 record-fixture.mjs 录下来的 landmark，不碰 MediaPipe。 */
export class FixtureLandmarkProvider implements LandmarkProvider {
  constructor(private readonly landmarks: Landmark[] | null) {}
  detect(): Landmark[] | null {
    return this.landmarks;
  }
}

/** 一帧的人脸度量，供元素定位和 size.ref 解算。 */
export interface FaceFrame {
  landmarks: Landmark[];
  /** 瞳距，px */
  iod: number;
  /** 单眼宽度（外眼角到内眼角），px */
  eyeWidth: number;
  /** 太阳穴到太阳穴，px */
  faceWidth: number;
  /** 头部滚转，弧度 */
  roll: number;
}

/** 丢脸容忍：短暂检测失败时保持上一帧，超过这个时长才判定为没有人。 */
const FACE_GRACE_MS = 500;

// 内部用的裸 mesh 编号。JSON 里禁止出现数字，引擎内部无所谓。
const IRIS_L = 468;
const IRIS_R = 473;
const EYE_OUTER_L = 33;
const EYE_INNER_L = 133;
const TEMPLE_L = 127;
const TEMPLE_R = 356;

export class FaceTracker {
  private provider: LandmarkProvider | null = null;
  private last: Landmark[] | null = null;
  private lastSeenMs = -Infinity;
  private W = 1280;
  private H = 720;

  setProvider(p: LandmarkProvider) {
    this.provider?.close?.();
    this.provider = p;
  }

  hasProvider(): boolean {
    return this.provider !== null;
  }

  setViewport(w: number, h: number) {
    this.W = w;
    this.H = h;
  }

  detect(source: FrameSource, nowMs: number) {
    const lm = this.provider?.detect(source, nowMs);
    if (lm && lm.length >= 478) {
      this.last = lm;
      this.lastSeenMs = nowMs;
    }
  }

  /**
   * 当前帧的人脸度量，没有人脸返回 null。
   *
   * nowMs 由调用方传入而不是内部读 performance.now()——离线 harness 要能按固定
   * 时刻步进，内部读时钟会让渲染结果不可重现。
   */
  frame(nowMs: number): FaceFrame | null {
    const lm = this.last;
    if (!lm || nowMs - this.lastSeenMs > FACE_GRACE_MS) return null;

    const px = (i: number) => ({ x: lm[i].x * this.W, y: lm[i].y * this.H });
    const li = px(IRIS_L);
    const ri = px(IRIS_R);
    const iod = Math.hypot(ri.x - li.x, ri.y - li.y);
    const eo = px(EYE_OUTER_L);
    const ei = px(EYE_INNER_L);
    const tl = px(TEMPLE_L);
    const tr = px(TEMPLE_R);

    return {
      landmarks: lm,
      iod,
      eyeWidth: Math.hypot(ei.x - eo.x, ei.y - eo.y),
      faceWidth: Math.hypot(tr.x - tl.x, tr.y - tl.y),
      roll: Math.atan2(ri.y - li.y, ri.x - li.x),
    };
  }

  /** 解析语义锚点到归一化坐标。名字不认识返回 null。 */
  landmarkAt(frame: FaceFrame, name: string | number): Landmark | null {
    const idx = resolveLandmark(name);
    return idx !== null && idx < frame.landmarks.length ? frame.landmarks[idx] : null;
  }

  reset() {
    this.last = null;
    this.lastSeenMs = -Infinity;
  }

  dispose() {
    this.provider?.close?.();
    this.provider = null;
    this.reset();
  }
}
