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

/** 算运动强度时看哪些关节。只看四肢末端，理由见 measureMotion */
const MOTION_JOINTS = [
  POSE_ANCHORS.wrist_left,
  POSE_ANCHORS.wrist_right,
  POSE_ANCHORS.elbow_left,
  POSE_ANCHORS.elbow_right,
  POSE_ANCHORS.ankle_left,
  POSE_ANCHORS.ankle_right,
];
/**
 * 读到 1.0 需要多快，单位「肩宽/秒」。
 *
 * 真人卡点甩一下手臂，腕部大约 1 个肩宽走 0.15 秒 ≈ 6~7 肩宽/秒，
 * 所以 2.5 这个门槛在真机上很容易顶满 —— 这是有意的：
 * 参考素材里那一下是**满速**，不是「稍微快一点」。
 */
const MOTION_FULL = 2.5;
/**
 * 指数平滑系数。越大越黏。
 *
 * 0.82 大约是 5 帧的时间常数（30fps 下 ~0.17 秒）—— 够压掉检测噪声，
 * 又不至于把「卡点」那一下的锐度磨平。这个效果的灵魂正是那一下。
 */
const MOTION_SMOOTH = 0.82;

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
  /**
   * 运动强度 0~1：四肢末端相对肩宽的移动速度。
   *
   * **这是这个追踪器里唯一的跨帧量。** 其余度量（shoulderWidth、spread）
   * 都是当前帧的纯函数，而速度按定义就需要两帧 —— 从单帧姿态推不出来。
   *
   * 加它的理由：参考素材里人卡点一动，线条明显跟着加速；人站着不动时线条
   * 变化得很慢。那是**速度**驱动的，不是姿态驱动的（慢慢张开手臂时姿态在变
   * 但线条不该炸）。密度仍然走 spread，两者管不同的事。
   *
   * 代价是 fluidity 从此加入「需要 stepTo」那一族（和 trail / pinch-bloom /
   * bubbles 一样）：不能直接跳到任意 t，得按定步长积过去。
   */
  motion: number;
}

export class PoseTracker {
  private provider: PoseLandmarkProvider | null = null;
  private last: Landmark[] | null = null;
  private lastSeenMs = -1e9;
  /** 上一次算速度用的那一帧。只留一帧，够算一阶差分 */
  private prev: { points: Landmark[]; ms: number } | null = null;
  /** 平滑过的运动强度。见 MOTION_SMOOTH */
  private motion = 0;
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
      this.measureMotion(poses[0], nowMs);
      this.last = poses[0];
      this.lastSeenMs = nowMs;
    }
  }

  /**
   * 一阶差分算运动强度，再做指数平滑。
   *
   * 不平滑的话它会逐帧抖到没法用：检测本身有噪声，静止的人也能读出
   * 0.1~0.2 的「速度」。而这个量是拿来驱动节奏的，抖了整套线框就在
   * 快慢之间乱跳，读起来像卡顿而不是「跟着动作走」。
   */
  private measureMotion(points: Landmark[], nowMs: number) {
    const p = this.prev;
    this.prev = { points, ms: nowMs };
    if (!p) return;
    const dt = (nowMs - p.ms) / 1000;
    // 时间倒流或者间隔离谱（切模板、丢帧很久）就重来，别算出一个假的爆发
    if (dt <= 1e-4 || dt > 0.5) {
      this.motion = 0;
      return;
    }

    const px = (arr: Landmark[], i: number) => ({ x: arr[i].x * this.W, y: arr[i].y * this.H });
    const sl = px(points, POSE_ANCHORS.shoulder_left);
    const sr = px(points, POSE_ANCHORS.shoulder_right);
    const sw = Math.max(1, Math.hypot(sr.x - sl.x, sr.y - sl.y));

    /*
     * 只看四肢末端。躯干和头在整个人平移时也会动，
     * 而「卡点」是手脚在动 —— 把躯干算进来的话，人走两步就误判成发力。
     */
    let sum = 0;
    let peak = 0;
    for (const j of MOTION_JOINTS) {
      const a = px(points, j);
      const b = px(p.points, j);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      sum += d;
      peak = Math.max(peak, d);
    }
    /*
     * 均值和峰值各占一半，不是纯均值。
     *
     * 纯均值下「一条手臂猛地甩出去」会被另外五个不动的关节稀释掉一半以上 ——
     * 而那正是「卡点」最典型的动作，也正是线条最该加速的那一刻。
     * 纯峰值又会让检测噪声（某一帧某个点跳一下）直接顶满。
     * 各占一半：整体在动和单肢发力都读得到，单点噪声顶不满。
     */
    const speed = (0.5 * (sum / MOTION_JOINTS.length) + 0.5 * peak) / sw / dt;
    const raw = Math.max(0, Math.min(1, speed / MOTION_FULL));
    this.motion = this.motion * MOTION_SMOOTH + raw * (1 - MOTION_SMOOTH);
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
      motion: this.motion,
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
    this.prev = null;
    this.motion = 0;
  }

  dispose() {
    this.provider?.close?.();
    this.provider = null;
    this.reset();
  }
}
