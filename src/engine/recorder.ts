/**
 * 录制。产品的主要卖点就是这一步：参考站只能看不能导出，创作者得自己录屏。
 *
 * 格式优先 mp4：抖音 / Reels 收不了 webm，iPhone 本地也打不开。
 * 拿不到 mp4 就降级 webm，并把这个事实告诉调用方，由 UI 明确提示用户
 * 「该格式部分平台无法直传」（PRD 4.2）。
 */

const PREFERRED = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return PREFERRED.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

export function containerOf(mime: string): "mp4" | "webm" {
  return mime.includes("mp4") ? "mp4" : "webm";
}

export interface RecordingResult {
  blob: Blob;
  url: string;
  mime: string;
  container: "mp4" | "webm";
  durationMs: number;
}

export interface RecorderOptions {
  canvas: HTMLCanvasElement;
  /** 可选麦克风轨。默认关闭——GRWM 类内容要说话，但得用户明确打开。 */
  audio?: MediaStream | null;
  fps?: number;
  /** 防内存溢出的硬上限（PRD 4.2）。 */
  maxMs?: number;
  onTick?: (elapsedMs: number) => void;
  onStop?: (r: RecordingResult) => void;
}

export class StudioRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: RecorderOptions;

  constructor(opts: RecorderOptions) {
    this.opts = opts;
  }

  get recording() {
    return this.recorder !== null;
  }

  start() {
    if (this.recorder) return;
    const stream = this.opts.canvas.captureStream(this.opts.fps ?? 30);
    this.opts.audio?.getAudioTracks().forEach((t) => stream.addTrack(t));

    const mime = pickMimeType();
    const config: MediaRecorderOptions = { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 128_000 };
    if (mime) config.mimeType = mime;
    try {
      this.recorder = new MediaRecorder(stream, config);
    } catch {
      // Safari 对参数挑剔，抛了就交给浏览器默认，不能让「点了录制没反应」
      this.recorder = new MediaRecorder(stream);
    }

    this.chunks = [];
    this.startedAt = Date.now();
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const used = this.recorder?.mimeType || mime || "video/webm";
      const blob = new Blob(this.chunks, { type: used.split(";")[0] });
      const result: RecordingResult = {
        blob,
        url: URL.createObjectURL(blob),
        mime: used,
        container: containerOf(used),
        durationMs: Date.now() - this.startedAt,
      };
      this.cleanup();
      this.opts.onStop?.(result);
    };
    this.recorder.start();

    const maxMs = this.opts.maxMs ?? 60_000;
    this.timer = setInterval(() => {
      const elapsed = Date.now() - this.startedAt;
      this.opts.onTick?.(elapsed);
      if (elapsed >= maxMs) this.stop();
    }, 200);
  }

  stop() {
    this.recorder?.stop();
  }

  private cleanup() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.recorder = null;
  }
}

/**
 * 直接存到相册。
 *
 * 网页存相册只有这一条正路：Web Share API 带文件，调起系统分享面板 ——
 * iOS Safari 的面板里有「存储视频」，Android 的有「保存到相册」。
 * `<a download>` 在 iOS 上不行：Safari 会**打开**文件而不是下载，
 * 用户得长按视频再存，就是 Gary 说的「有点麻烦」。
 *
 * 三个前提缺一不可，所以先问 canShare 再调：
 *   - HTTPS（生产满足，本地 http 不行）
 *   - 用户手势里调用（按钮点击满足）
 *   - 文件类型系统认。**webm 相册不收** —— 那是降级容器，
 *     只有拿不到 mp4 编码器时才会出现，这时如实告诉用户比静默失败好。
 *
 * 返回没成功的原因，让 UI 决定说什么；用户自己取消不算失败。
 */
export async function saveToPhotos(
  result: RecordingResult,
  slug: string,
): Promise<"ok" | "cancelled" | "unsupported" | "webm"> {
  const name = `ar-${slug}-${Date.now()}.${result.container}`;
  const file = new File([result.blob], name, { type: result.mime });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share !== "function" || !nav.canShare?.({ files: [file] })) {
    return result.container === "webm" ? "webm" : "unsupported";
  }
  try {
    await nav.share({ files: [file] });
    return "ok";
  } catch (e) {
    // 用户在面板上点了取消 —— 不是错误，别弹提示
    if ((e as Error).name === "AbortError") return "cancelled";
    return "unsupported";
  }
}

export function download(result: RecordingResult, slug: string) {
  const a = document.createElement("a");
  a.href = result.url;
  a.download = `ar-${slug}-${Date.now()}.${result.container}`;
  a.click();
}
