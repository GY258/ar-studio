/**
 * 全身姿态追踪：33 点 landmark + 每帧的姿态度量。
 *
 * 结构照 FaceTracker / HandTracker 抄，理由也一样：检测能力藏在 provider 后面，
 * 离线验证要能在没有摄像头、没有 GPU、没有外网的条件下回放录好的 landmark。
 * CI 里永远不跑 MediaPipe —— 模型走 storage.googleapis.com，国内不通，CI 同样不通。
 *
 * ⚠️ 加这个追踪器意味着**再多下一个模型**。生产现在还指着 googleapis，
 * 国内本来就加载不出来，多一个只会更糟。见 docs/ROADMAP.md 的「模型自托管」。
 */

import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import { WASM_BASE, POSE_MODEL } from "@/lib/assets";
import type { FrameSource, Landmark } from "./face-tracker";
import { POSE_ANCHORS, type PoseAnchorName } from "./pose-anchors";

export interface PoseLandmarkProvider {
  /** 本帧检测到的人；没人返回空数组（调用方按 grace 保留上一帧）。null = 检测器还没就绪 */
  detect(source: FrameSource, nowMs: number): Landmark[][] | null;
  close?(): void;
}

/** 线上实现。 */
export class MediaPipePoseProvider implements PoseLandmarkProvider {
  private landmarker: PoseLandmarker | null = null;
  private loading = false;

  async load(): Promise<void> {
    if (this.landmarker || this.loading) return;
    this.loading = true;
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
        runningMode: "VIDEO",
        // 只追一个人。多人会让框和线在两个人之间乱连，而这个效果的读法是
        // 「机器在解析**这个人**的运动」
        numPoses: 1,
      });
    } finally {
      this.loading = false;
    }
  }

  detect(source: FrameSource, nowMs: number): Landmark[][] | null {
    if (!this.landmarker) return null;
    const r: PoseLandmarkerResult = this.landmarker.detectForVideo(source, nowMs);
    if (!r.landmarks?.length) return [];
    return r.landmarks as Landmark[][];
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

/** fixture 里姿态数据的两种形态。数组 = 单帧，对象 = 序列。 */
export type PoseFixture = Landmark[][] | { fps: number; frames: Landmark[][][] };

/** 回放录好的姿态 landmark。序列会按 nowMs 循环，理由同 FixtureHandProvider。 */
export class FixturePoseProvider implements PoseLandmarkProvider {
  private readonly fps: number;
  private readonly frames: Landmark[][][];

  constructor(fixture: PoseFixture | null) {
    if (!fixture) {
      this.fps = 30;
      this.frames = [];
    } else if (Array.isArray(fixture)) {
      this.fps = 30;
      this.frames = [fixture];
    } else {
      this.fps = fixture.fps || 30;
      this.frames = fixture.frames;
    }
  }

  detect(_source: FrameSource, nowMs: number): Landmark[][] | null {
    if (!this.frames.length) return null;
    const i = Math.floor((Math.max(0, nowMs) / 1000) * this.fps) % this.frames.length;
    return this.frames[i];
  }
}

/**
 * 丢人容忍。比手的 250ms 长：整个人不会像手那样瞬间移出画面，
 * 而全身检测在快速动作下偶尔丢一两帧是常态，保太短会让整套线框闪。
 */
const POSE_GRACE_MS = 400;

export interface PoseFrame {
  /** 33 点，归一化到画面，y 向下 */
  points: Landmark[];
  /** 肩宽，px。人退远会一起变小，是姿态元素的天然尺寸参照物 */
  shoulderWidth: number;
  /**
   * 舒展度 0~1：双腕间距 / 肩宽，映射到 0~1。
   *
   * **是当前帧的纯函数，不是运动速度。** 参考素材里「张开手臂时框和线爆发式
   * 增多、收拢时骤减」，差别在**姿态本身**而不是快慢 —— 慢慢张开手臂一样该炸。
   * 用姿态而不是用帧间速度，还顺带保住了 renderAt(t) 的无历史性。
   */
  spread: number;
  /** 躯干中心，归一化坐标。框和线的密度按到它的距离衰减 */
  center: { x: number; y: number };
}

export class PoseTracker {
  private provider: PoseLandmarkProvider | null = null;
  private last: Landmark[] | null = null;
  private lastSeenMs = -1e9;
  private W = 1280;
  private H = 720;

  setProvider(p: PoseLandmarkProvider) {
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
    if (!this.provider) return;
    const poses = this.provider.detect(source, nowMs);
    // null = 检测器还没就绪；[] = 就绪但这一帧没人。后者也算「检测过了」，
    // 但不刷新 lastSeenMs，让 grace 正常过期
    if (poses === null) return;
    if (poses.length > 0) {
      this.last = poses[0];
      this.lastSeenMs = nowMs;
    }
  }

  /** 本帧可用的姿态。超过 grace 返回 null，元素据此隐藏。 */
  frame(nowMs: number): PoseFrame | null {
    const lm = this.last;
    if (!lm || nowMs - this.lastSeenMs > POSE_GRACE_MS) return null;

    const px = (i: number) => ({ x: lm[i].x * this.W, y: lm[i].y * this.H });
    const sl = px(POSE_ANCHORS.shoulder_left);
    const sr = px(POSE_ANCHORS.shoulder_right);
    const wl = px(POSE_ANCHORS.wrist_left);
    const wr = px(POSE_ANCHORS.wrist_right);
    const hl = px(POSE_ANCHORS.hip_left);
    const hr = px(POSE_ANCHORS.hip_right);

    const shoulderWidth = Math.max(1, Math.hypot(sr.x - sl.x, sr.y - sl.y));
    /*
     * 双腕间距 / 肩宽：手垂在身侧约 1.0~1.5，完全张开约 3.5~4。
     * 映射到 0~1 时下界取 1.2 而不是 0 —— 自然站姿本来就有一点间距，
     * 从 0 起算的话「什么都不做」也会读到 0.3 的舒展度，静止时该清爽的画面清爽不下来。
     */
    const armSpan = Math.hypot(wr.x - wl.x, wr.y - wl.y) / shoulderWidth;
    const spread = Math.max(0, Math.min(1, (armSpan - 1.2) / 2.3));

    return {
      points: lm,
      shoulderWidth,
      spread,
      center: {
        x: (lm[POSE_ANCHORS.shoulder_left].x + lm[POSE_ANCHORS.shoulder_right].x + hl.x / this.W + hr.x / this.W) / 4,
        y: (lm[POSE_ANCHORS.shoulder_left].y + lm[POSE_ANCHORS.shoulder_right].y + hl.y / this.H + hr.y / this.H) / 4,
      },
    };
  }

  /** 解析语义锚点到归一化坐标。名字不认识返回 null，让校验器去报错而不是画到 (0,0)。 */
  landmarkAt(f: PoseFrame, name: string): Landmark | null {
    const idx = POSE_ANCHORS[name as PoseAnchorName];
    if (idx === undefined) return null;
    return f.points[idx] ?? null;
  }

  reset() {
    this.last = null;
    this.lastSeenMs = -1e9;
  }

  dispose() {
    this.provider?.close?.();
    this.provider = null;
    this.reset();
  }
}
