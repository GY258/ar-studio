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

export function download(result: RecordingResult, slug: string) {
  const a = document.createElement("a");
  a.href = result.url;
  a.download = `ar-${slug}-${Date.now()}.${result.container}`;
  a.click();
}
