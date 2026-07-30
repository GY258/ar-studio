/**
 * fixture 录制（浏览器侧）。只有开发者本地手动跑，不进 CI。
 *
 * 真跑一次 MediaPipe，把产物固化成文件。之后所有离线验证回放这些文件，
 * CI 里永远不下载模型、不需要 GPU、不受 jsdelivr 连通性影响。
 * 模型或素材换代时手动重录一次即可。
 */

import { MediaPipeLandmarkProvider } from "@/engine/face-tracker";
import { MediaPipeSegmentationProvider } from "@/engine/segmentation";
import { MediaPipeHandProvider } from "@/engine/hand-tracker";

interface Recorded {
  landmarks: { x: number; y: number; z: number }[] | null;
  /** 分割置信度 0~1，逐像素。写文件时再量化成 8bit 灰度 */
  mask: { data: number[]; w: number; h: number } | null;
  /** 手部：每只手 21 点 + 是本人的左手还是右手 */
  hands: { hand: "left" | "right"; points: { x: number; y: number; z: number }[] }[] | null;
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
  private hands: MediaPipeHandProvider | null = null;

  /** 会话级单调时钟，毫秒。见 record() 里的注释 */
  private clock = 0;

  async load() {
    this.face = new MediaPipeLandmarkProvider();
    this.seg = new MediaPipeSegmentationProvider();
    this.hands = new MediaPipeHandProvider();
    await Promise.all([this.face.load(), this.seg.load(), this.hands.load()]);
  }

  async record(src: string): Promise<Recorded> {
    const img = await loadImage(src);

    /*
     * VIDEO 模式要求时间戳单调递增，而且是**整个会话内**递增，不是每张图各数各的。
     * 原来这里写的是 i * 33，于是第一张 fixture 喂到 132ms，第二张又从 0 开始，
     * MediaPipe 直接抛 "Packet timestamp mismatch ... expected 132001 but received 0"。
     * 一次只录一张时看不出来，录一批必炸 —— 而批量正是它的默认用法。
     */
    let landmarks: Recorded["landmarks"] = null;
    for (let i = 0; i < 5; i++) {
      landmarks = this.face!.detect(img, (this.clock += 33)) ?? landmarks;
    }

    let hands: Recorded["hands"] = null;
    for (let i = 0; i < 5; i++) {
      const h = this.hands!.detect(img, (this.clock += 33));
      if (h && h.length) hands = h.map((x) => ({ hand: x.hand, points: x.points }));
    }

    let mask: Recorded["mask"] = null;
    for (let i = 0; i < 5; i++) {
      this.seg!.segment(img, (this.clock += 33), (data, w, h) => {
        mask = { data: Array.from(data), w, h };
      });
    }

    return {
      landmarks: landmarks
        ? landmarks.map((p) => ({ x: round(p.x), y: round(p.y), z: round(p.z) }))
        : null,
      mask,
      hands: hands
        ? hands.map((h) => ({
            hand: h.hand,
            points: h.points.map((p) => ({ x: round(p.x), y: round(p.y), z: round(p.z) })),
          }))
        : null,
    };
  }
}

function round(v: number) {
  return Math.round(v * 1e6) / 1e6;
}

(window as unknown as { recorder: Recorder }).recorder = new Recorder();
