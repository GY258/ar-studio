/**
 * 手部追踪：21 点 landmark + 每帧的手部度量。
 *
 * 结构照 FaceTracker 抄，理由也一样：检测能力藏在 provider 后面，
 * 离线验证要能在没有摄像头、没有 GPU、没有外网的条件下回放录好的 landmark。
 * CI 里永远不跑 MediaPipe —— 模型走 jsdelivr / storage.googleapis.com，国内不通，CI 同样不通。
 *
 * 在这之前，`perception: ["hands"]` 是个**静默失效的枚举值**：
 * types.ts 和 validate.ts 都认它，而 engine.perceive() 没有对应分支 ——
 * 模板写了能过校验、能正常渲染、什么都不会发生、也不报错。和当初的 blur 一模一样。
 */

import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { WASM_BASE, HAND_MODEL } from "@/lib/assets";
import type { FrameSource, Landmark } from "./face-tracker";
import { HAND_ANCHORS, type HandAnchorName } from "./hand-anchors";

/**
 * 哪只手。**说的是本人的左右手**，不是画面上的左右 ——
 * 画面是镜像的（背景平面 scale.x = -1），所以本人的左手出现在屏幕右侧。
 * 模板作者按「戴戒指的那只手」思考，而不是按屏幕位置思考。
 */
export type Handedness = "left" | "right";

export interface HandLandmarks {
  hand: Handedness;
  /** 21 点，归一化到画面，y 向下 */
  points: Landmark[];
}

export interface HandLandmarkProvider {
  /** 返回本帧检测到的手；一只都没有返回空数组（调用方按 grace 保留上一帧）。 */
  detect(source: FrameSource, nowMs: number): HandLandmarks[] | null;
  close?(): void;
}

/** 线上实现。 */
export class MediaPipeHandProvider implements HandLandmarkProvider {
  private landmarker: HandLandmarker | null = null;
  private loading = false;

  async load(): Promise<void> {
    if (this.landmarker || this.loading) return;
    this.loading = true;
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
      });
    } finally {
      this.loading = false;
    }
  }

  detect(source: FrameSource, nowMs: number): HandLandmarks[] | null {
    if (!this.landmarker) return null;
    const r: HandLandmarkerResult = this.landmarker.detectForVideo(source, nowMs);
    if (!r.landmarks?.length) return [];
    return r.landmarks.map((points, i) => ({
      // handedness 的 categoryName 是 "Left" / "Right"，说的是本人的手
      hand: (r.handedness?.[i]?.[0]?.categoryName ?? "Right").toLowerCase() === "left" ? "left" : "right",
      points: points as Landmark[],
    }));
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

/** 回放录好的手部 landmark。 */
export class FixtureHandProvider implements HandLandmarkProvider {
  constructor(private readonly hands: HandLandmarks[] | null) {}

  detect(): HandLandmarks[] | null {
    return this.hands;
  }
}

/** 丢手容忍。比人脸的 500ms 短：手动得快，保太久会看到贴纸黏在空气里。 */
const HAND_GRACE_MS = 250;

const INDEX_MCP = HAND_ANCHORS.index_mcp;
const PINKY_MCP = HAND_ANCHORS.pinky_mcp;
const WRIST = HAND_ANCHORS.wrist;
const MIDDLE_MCP = HAND_ANCHORS.middle_mcp;

export interface HandFrame {
  hand: Handedness;
  points: Landmark[];
  /** 掌宽（食指根到小指根），px。人退远会一起变小，是手部元素的天然尺寸参照物 */
  palmWidth: number;
  /** 手腕到中指根的方向角，弧度。手转的时候贴纸要不要跟着转由模板决定 */
  roll: number;
}

export class HandTracker {
  private provider: HandLandmarkProvider | null = null;
  private last: HandLandmarks[] | null = null;
  private lastSeenMs = -1e9;
  private W = 1280;
  private H = 720;

  setProvider(p: HandLandmarkProvider) {
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
    const hands = this.provider.detect(source, nowMs);
    // null = 检测器还没就绪；[] = 就绪但这一帧没有手。后者也算「检测过了」，
    // 但不刷新 lastSeenMs，让 grace 正常过期
    if (hands === null) return;
    if (hands.length > 0) {
      this.last = hands;
      this.lastSeenMs = nowMs;
    }
  }

  /** 本帧可用的手。超过 grace 就返回空数组，元素据此隐藏。 */
  frames(nowMs: number): HandFrame[] {
    if (!this.last || nowMs - this.lastSeenMs > HAND_GRACE_MS) return [];
    return this.last.map((h) => {
      const px = (i: number) => ({ x: h.points[i].x * this.W, y: h.points[i].y * this.H });
      const im = px(INDEX_MCP);
      const pm = px(PINKY_MCP);
      const wr = px(WRIST);
      const mm = px(MIDDLE_MCP);
      return {
        hand: h.hand,
        points: h.points,
        palmWidth: Math.hypot(pm.x - im.x, pm.y - im.y),
        roll: Math.atan2(mm.y - wr.y, mm.x - wr.x),
      };
    });
  }

  /** 指定的那只手。同一只手检测到两次时取第一个。 */
  frame(nowMs: number, hand: Handedness): HandFrame | null {
    return this.frames(nowMs).find((f) => f.hand === hand) ?? null;
  }

  /** 归一化坐标下的某个锚点。名字不在表里返回 null，让校验器去报错而不是画到 (0,0)。 */
  landmarkAt(f: HandFrame, name: string): Landmark | null {
    const idx = HAND_ANCHORS[name as HandAnchorName];
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
