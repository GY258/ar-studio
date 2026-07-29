/**
 * 人像分割。与 LandmarkProvider 对称——两个感知能力都要能在离线环境里被替换掉，
 * 否则 CI 就得下模型、开 GPU、连 jsdelivr（README 记过国内不通，CI 同样不通）。
 */

import { FilesetResolver, ImageSegmenter, type ImageSegmenterResult } from "@mediapipe/tasks-vision";
import { SEG_MODEL, WASM_BASE } from "@/lib/assets";
import type { FrameSource } from "./face-tracker";

/**
 * 回调拿到的是**置信度**原始数据（0~1，逐像素），不是已经平滑过的场，
 * 也不是被硬阈值切过的 categoryMask。
 *
 * 用 Float32Array 而不是 Uint8Array 是这一整条改动的关键：模型本来就输出连续值，
 * 头发丝、耳廓、肩线的真实过渡都在那些 0.3~0.7 的像素里。
 * 之前要的是 categoryMask —— MediaPipe 自己已经把它硬阈值切成 {0, 255} 了，
 * 实测一帧只有两个取值，而同一帧的 confidence 里有 3% 的像素落在 0.05~0.95 之间。
 * 那 3% 正是「抠得不准」的观感来源：它们被二选一之后，只能整块归人或整块归背景。
 */
export type MaskSink = (data: Float32Array, mw: number, mh: number) => void;

export interface SegmentationProvider {
  segment(source: FrameSource, nowMs: number, sink: MaskSink): void;
  close?(): void;
}

export class MediaPipeSegmentationProvider implements SegmentationProvider {
  private segmenter: ImageSegmenter | null = null;

  async load(): Promise<void> {
    if (this.segmenter) return;
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEG_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      // 要连续置信度，不要被切过的二值图。见 MaskSink 的注释
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  }

  segment(source: FrameSource, nowMs: number, sink: MaskSink): void {
    if (!this.segmenter) return;
    this.segmenter.segmentForVideo(source as HTMLVideoElement, nowMs, (r: ImageSegmenterResult) => {
      // selfie_segmenter 只有一个前景类，confidenceMasks[0] 就是「是人的概率」
      const m = r.confidenceMasks?.[0];
      if (m) {
        sink(m.getAsFloat32Array(), m.width, m.height);
        m.close();
      }
      r.close?.();
    });
  }

  close() {
    this.segmenter?.close();
    this.segmenter = null;
  }
}

/**
 * 回放录好的置信度图。
 *
 * 喂进去的必须是原始值而不是平滑过的场：OccupancyField.ingest 里那两步
 * （3×3 模糊 + α=0.45 时域平滑）要照常跑，否则离线渲染出来的边缘和线上不一致。
 *
 * fixture 存的是 8bit 灰度 PNG，调用方负责除以 255 变回 0~1。合成 fixture 是纯
 * 0/255，换算过来就是 0/1，和改造前逐位相同 —— 所以这条改动不动任何 golden。
 */
export class FixtureSegmentationProvider implements SegmentationProvider {
  constructor(
    private readonly data: Float32Array,
    private readonly mw: number,
    private readonly mh: number,
  ) {}

  segment(_source: FrameSource, _nowMs: number, sink: MaskSink): void {
    sink(this.data, this.mw, this.mh);
  }
}
