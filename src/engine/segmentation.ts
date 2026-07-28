/**
 * 人像分割。与 LandmarkProvider 对称——两个感知能力都要能在离线环境里被替换掉，
 * 否则 CI 就得下模型、开 GPU、连 jsdelivr（README 记过国内不通，CI 同样不通）。
 */

import { FilesetResolver, ImageSegmenter, type ImageSegmenterResult } from "@mediapipe/tasks-vision";
import { SEG_MODEL, WASM_BASE } from "@/lib/assets";
import type { FrameSource } from "./face-tracker";

/** 回调拿到的是 categoryMask 级别的原始数据，不是已经平滑过的场。 */
export type MaskSink = (data: Uint8Array, mw: number, mh: number) => void;

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
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  }

  segment(source: FrameSource, nowMs: number, sink: MaskSink): void {
    if (!this.segmenter) return;
    this.segmenter.segmentForVideo(source as HTMLVideoElement, nowMs, (r: ImageSegmenterResult) => {
      const m = r.categoryMask;
      if (m) {
        sink(m.getAsUint8Array(), m.width, m.height);
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
 * 回放录好的 categoryMask。
 *
 * 喂进去的必须是原始 mask 而不是平滑过的场：OccupancyField.ingest 里那两步
 * （3×3 模糊 + α=0.45 时域平滑）要照常跑，否则离线渲染出来的边缘和线上不一致。
 */
export class FixtureSegmentationProvider implements SegmentationProvider {
  constructor(
    private readonly data: Uint8Array,
    private readonly mw: number,
    private readonly mh: number,
  ) {}

  segment(_source: FrameSource, _nowMs: number, sink: MaskSink): void {
    sink(this.data, this.mw, this.mh);
  }
}
