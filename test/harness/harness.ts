/**
 * 离线渲染 harness（浏览器侧）。
 *
 * 用一张静态图当画面源 + 回放录好的 landmark 和 mask，把引擎完整跑起来，
 * 然后按调用方给的时刻逐帧渲染。全程不碰摄像头、不碰 MediaPipe、不联网。
 *
 * 时钟完全由外部给：renderAt(t) 里没有 performance.now()、没有 rAF、没有随机数，
 * 同一份输入渲染多少次都是同一张图 —— golden 对比就建立在这一点上。
 */

import { ArEngine } from "@/engine/engine";
import { FixtureLandmarkProvider, type Landmark } from "@/engine/face-tracker";
import { FixtureSegmentationProvider } from "@/engine/segmentation";
import { migrateElements } from "@/lib/migrate";
import type { TemplateConfig } from "@/engine/types";

type Raw = Record<string, unknown>;

/**
 * 时域平滑 α=0.45，单帧 ingest 只能把占据场推到 0.45，
 * 而 shader 里 smoothstep(0.42, 0.58) 在 0.45 处几乎还是 0。
 * 连喂 14 帧收敛到 >0.999，蒙版才是稳态。少喂几帧截出来的图是「正在淡入」的中间态。
 */
const MASK_WARMUP_FRAMES = 14;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`加载不了 ${src}`));
    img.src = src;
  });
}

/** 从灰度 PNG 取回 categoryMask。只用 R 通道，和 MediaPipe 的单通道输出对齐。 */
async function loadMask(src: string): Promise<{ data: Uint8Array; w: number; h: number }> {
  const img = await loadImage(src);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const data = new Uint8Array(c.width * c.height);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4];
  return { data, w: c.width, h: c.height };
}

class Harness {
  private engine: ArEngine | null = null;
  private canvas: HTMLCanvasElement | null = null;

  /** 建引擎，挂上 fixture 的画面源和两个 provider。 */
  async setup(opts: { fixture: string; width: number; height: number }) {
    this.teardown();

    const canvas = document.createElement("canvas");
    canvas.id = "stage";
    canvas.style.width = `${opts.width}px`;
    canvas.style.height = `${opts.height}px`;
    document.body.innerHTML = "";
    document.body.appendChild(canvas);
    this.canvas = canvas;

    const base = `/fixtures/${opts.fixture}`;
    const [image, mask, landmarks] = await Promise.all([
      loadImage(`${base}.png`),
      loadMask(`${base}.mask.png`),
      fetch(`${base}.landmarks.json`).then((r) => r.json() as Promise<Landmark[] | null>),
    ]);

    const engine = new ArEngine({ canvas, onError: (e) => console.error("[engine]", e.message) });
    engine.setLandmarkProvider(new FixtureLandmarkProvider(landmarks));
    engine.setSegmentationProvider(new FixtureSegmentationProvider(mask.data, mask.w, mask.h));
    engine.setSource(image);
    this.engine = engine;
  }

  /** 吃一份模板原始 JSON，走和线上完全同一条 migrate + expand 通路。 */
  async loadTemplate(raw: Raw) {
    if (!this.engine) throw new Error("先调 setup()");
    const { elements } = migrateElements(raw);
    const cfg: TemplateConfig = {
      slug: raw.slug as string,
      name: raw.name as TemplateConfig["name"],
      category: raw.category as string,
      priceCents: (raw.price_cents as number) ?? 0,
      preview: {},
      locked: false,
      templateType: (raw.template_type as TemplateConfig["templateType"]) ?? "particle",
      perception: (raw.perception ?? []) as TemplateConfig["perception"],
      emitter: raw.emitter as TemplateConfig["emitter"],
      substance: raw.substance as TemplateConfig["substance"],
      controls: (raw.controls ?? []) as TemplateConfig["controls"],
      elements,
      source: raw.source as TemplateConfig["source"],
    };
    this.engine.setTemplate(cfg);
    await this.engine.whenReady();

    // 让占据场收敛到稳态，再交给调用方截图
    for (let i = 0; i < MASK_WARMUP_FRAMES; i++) this.engine.renderAt(0);
    return elements.length;
  }

  /** 渲染指定时刻。t 单位秒。 */
  render(t: number) {
    if (!this.engine) throw new Error("先调 setup()");
    this.engine.renderAt(t);
  }

  /** 把当前帧读成 PNG dataURL。canvas.toDataURL 依赖 preserveDrawingBuffer。 */
  snapshot(): string {
    if (!this.canvas) throw new Error("先调 setup()");
    return this.canvas.toDataURL("image/png");
  }

  teardown() {
    this.engine?.dispose();
    this.engine = null;
    this.canvas = null;
  }
}

// harness-driver.ts（Node 侧）声明的是同名结构类型，这里不再重复 declare global，
// 否则两个声明会打架。
(window as unknown as { harness: Harness }).harness = new Harness();
