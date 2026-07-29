/**
 * fixture 录制（浏览器侧）。只有开发者本地手动跑，不进 CI。
 *
 * 真跑一次 MediaPipe，把产物固化成文件。之后所有离线验证回放这些文件，
 * CI 里永远不下载模型、不需要 GPU、不受 jsdelivr 连通性影响。
 * 模型或素材换代时手动重录一次即可。
 */

import { MediaPipeLandmarkProvider } from "@/engine/face-tracker";
import { MediaPipeSegmentationProvider } from "@/engine/segmentation";

interface Recorded {
  landmarks: { x: number; y: number; z: number }[] | null;
  /** 分割置信度 0~1，逐像素。写文件时再量化成 8bit 灰度 */
  mask: { data: number[]; w: number; h: number } | null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`加载不了 ${src}`));
    img.src = src;
  });
}

class Recorder {
  private face: MediaPipeLandmarkProvider | null = null;
  private seg: MediaPipeSegmentationProvider | null = null;

  async load() {
    this.face = new MediaPipeLandmarkProvider();
    this.seg = new MediaPipeSegmentationProvider();
    await Promise.all([this.face.load(), this.seg.load()]);
  }

  async record(src: string): Promise<Recorded> {
    const img = await loadImage(src);

    // VIDEO 模式要求时间戳单调递增，静态图连喂几帧让检测稳定下来
    let landmarks: Recorded["landmarks"] = null;
    for (let i = 0; i < 5; i++) {
      landmarks = this.face!.detect(img, i * 33) ?? landmarks;
    }

    let mask: Recorded["mask"] = null;
    for (let i = 0; i < 5; i++) {
      this.seg!.segment(img, i * 33, (data, w, h) => {
        mask = { data: Array.from(data), w, h };
      });
    }

    return {
      landmarks: landmarks
        ? landmarks.map((p) => ({ x: round(p.x), y: round(p.y), z: round(p.z) }))
        : null,
      mask,
    };
  }
}

function round(v: number) {
  return Math.round(v * 1e6) / 1e6;
}

(window as unknown as { recorder: Recorder }).recorder = new Recorder();
