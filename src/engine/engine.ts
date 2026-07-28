import * as THREE from "three";
import { OccupancyField } from "./occupancy";
import {
  MediaPipeSegmentationProvider,
  type SegmentationProvider,
} from "./segmentation";
import { ParticleSystem } from "./particles";
import { ElementRenderer } from "./element-renderer";
import { FaceTracker, MediaPipeLandmarkProvider, type FrameSource, type LandmarkProvider } from "./face-tracker";
import { propCanvas } from "./props";
import { resolveControls } from "./resolve";
import type { ControlValues, TemplateConfig, TemplateType } from "./types";

export interface EngineStats {
  fps: number;
  tracking: boolean;
  degraded: boolean;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** 线上是摄像头 video。离线 harness 传静态图，走 setSource() */
  video?: HTMLVideoElement;
  onStats?: (s: EngineStats) => void;
  onError?: (e: Error) => void;
}

/**
 * 渲染管线（PRD 5.2）：
 *   getUserMedia → video → ImageSegmenter（每视频帧）→ 占据场
 *   → 粒子（CPU 积分，GPU 绘制）→ Three.js 合成 → captureStream
 *
 * 检测和渲染解耦：分割只在有新视频帧时跑（靠 currentTime 变化判断），渲染仍然满帧。
 */
export class ArEngine {
  private readonly video: HTMLVideoElement | null;
  /** 当前画面源。摄像头 video 或离线 harness 的静态图 / canvas。 */
  private source: FrameSource;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-640, 640, 360, -360, -100, 100);
  private readonly bg: THREE.Mesh;
  private sourceTex: THREE.Texture;
  private bgMat: THREE.Material;
  private maskTex: THREE.DataTexture | null = null;
  private readonly prop: THREE.Mesh;
  private readonly propMat: THREE.MeshBasicMaterial;
  private readonly field = new OccupancyField();
  private readonly particles = new ParticleSystem();
  private readonly propTextures = new Map<string, THREE.Texture>();

  private W = 1280;
  private H = 720;
  private cfg: TemplateConfig | null = null;
  private controls: ControlValues = {};
  /** 归一化屏幕坐标，(0,0) 是中心，y 向上为正。 */
  private emitPos = { x: 0, y: 0.34 };
  private readonly elements: ElementRenderer;
  private readonly faceTracker = new FaceTracker();
  private templateType: TemplateType = "particle";
  private perception: string[] = ["segmentation"];
  private segProvider: SegmentationProvider | null = null;
  /** 丢人兜底策略，来自 source.mask.onLost */
  private onLost: "clear" | "hold" | "full" = "clear";
  private applyOutside = true;
  /** source.effect.blocks，短边格数。resize 时要按新比例重算长边格数 */
  private blocks = 0;
  private raf = 0;
  private lastT = 0;
  private lastVideoTime = -1;
  private fpsAcc = 0;
  private fpsN = 0;
  private fps = 0;
  private running = false;
  private degraded = false;
  private dragging = false;
  private grab = { x: 0, y: 0 };
  private readonly onStats?: (s: EngineStats) => void;
  private readonly onError?: (e: Error) => void;

  constructor(opts: EngineOptions) {
    this.video = opts.video ?? null;
    this.source = opts.video ?? document.createElement("canvas");
    this.onStats = opts.onStats;
    this.onError = opts.onError;

    // preserveDrawingBuffer：离线 harness 要在 render 之后截图，不保留会拿到空白帧
    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 1);

    this.sourceTex = makeSourceTexture(this.source);
    this.bgMat = new THREE.MeshBasicMaterial({ map: this.sourceTex });
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.bgMat);
    this.bg.position.z = -1;
    this.bg.renderOrder = 0;
    this.scene.add(this.bg);

    this.particles.addTo(this.scene);

    this.propMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false });
    this.prop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.propMat);
    this.prop.position.z = 1;
    this.prop.renderOrder = 3; // 必须压在粒子之上，雪才是从云里出来的
    this.scene.add(this.prop);

    this.elements = new ElementRenderer(this.scene);

    this.attachDrag(opts.canvas);
    this.resize();
  }

  /**
   * 换画面源。离线验证靠这个把摄像头换成一张静态图 —— 不换的话，
   * 没有摄像头就一帧都渲染不出来，LLM 写完模板拿不到任何反馈。
   */
  setSource(el: FrameSource) {
    this.source = el;
    this.sourceTex.dispose();
    this.sourceTex = makeSourceTexture(el);
    const mat = this.bgMat as THREE.MeshBasicMaterial & { uniforms?: Record<string, { value: unknown }> };
    if (mat.uniforms?.videoTex) mat.uniforms.videoTex.value = this.sourceTex;
    else if (mat.map !== undefined) {
      mat.map = this.sourceTex;
      mat.needsUpdate = true;
    }
    this.resize();
  }

  /** 注入 landmark 来源。不调用则用 MediaPipe，测试里注入 fixture 回放。 */
  setLandmarkProvider(p: LandmarkProvider) {
    this.faceTracker.setProvider(p);
  }

  /** 元素纹理全部就绪。截图前必须等它，否则会拍到一张空白帧。 */
  whenReady(): Promise<void> {
    return this.elements.ready();
  }

  /** 注入分割来源。不调用则用 MediaPipe，测试里注入 fixture 回放。 */
  setSegmentationProvider(p: SegmentationProvider) {
    this.segProvider?.close?.();
    this.segProvider = p;
  }

  /* ---------------- 生命周期 ---------------- */

  async loadPerception(): Promise<void> {
    if (this.segProvider) return; // 已注入 fixture provider 就别再拉模型
    const provider = new MediaPipeSegmentationProvider();
    await provider.load();
    this.segProvider = provider;
  }

  async loadFace(): Promise<void> {
    if (this.faceTracker.hasProvider()) return; // 已注入 fixture provider 就别再拉模型
    const provider = new MediaPipeLandmarkProvider();
    await provider.load();
    this.faceTracker.setProvider(provider);
  }

  /** 不强制比例，让摄像头用原生分辨率，cover 模式负责显示裁剪。 */
  async startCamera(deviceId?: string): Promise<void> {
    if (!this.video) throw new Error("startCamera 需要一个 video 元素；离线模式请用 setSource()");
    this.degraded = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: this.degraded ? 1280 : 1920 },
        height: { ideal: this.degraded ? 960 : 1080 },
        facingMode: "user",
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    // videoWidth/videoHeight 在 play 后才可靠，再 resize 一次确保 cover 比例正确
    this.video.addEventListener("loadedmetadata", () => this.resize(), { once: true });
    this.resize();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    if (this.video) {
      const stream = this.video.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
    }
    this.segProvider?.close?.();
    this.particles.dispose();
    this.elements.dispose();
    this.faceTracker.dispose();
    this.sourceTex.dispose();
    this.propTextures.forEach((t) => t.dispose());
    this.renderer.dispose();
  }

  /* ---------------- 配置 ---------------- */

  setTemplate(cfg: TemplateConfig) {
    this.cfg = cfg;
    this.templateType = cfg.templateType ?? "particle";
    // facetrack 模板即使 JSON 没写 perception 也需要人脸，这里补上，
    // 否则 perception 驱动的分发不会去检测 landmark。
    this.perception = cfg.perception?.length
      ? [...cfg.perception]
      : this.templateType === "particle"
        ? ["segmentation"]
        : this.templateType === "facetrack"
          ? ["face"]
          : [];
    if (this.templateType === "facetrack" && !this.perception.includes("face")) {
      this.perception.push("face");
    }
    // 有 face 空间元素的 overlay 模板同样需要人脸
    if (cfg.elements?.some((e) => e.anchor.space === "face") && !this.perception.includes("face")) {
      this.perception.push("face");
    }

    // 清理其他类型的渲染状态
    this.elements.clear();
    this.faceTracker.reset();
    this.particles.clear();
    this.particles.hide();
    this.prop.visible = false;

    if (this.templateType === "particle" && cfg.emitter && cfg.substance) {
      this.particles.show();
      this.emitPos = { ...cfg.emitter.default };
      this.particles.applySubstance(cfg.substance);
      this.propMat.map = this.propTexture(cfg);
      this.propMat.needsUpdate = true;
      this.prop.visible = true;
      this.layoutProp();
    }

    // 元素不再按 templateType 分流：overlay 和 facetrack 走同一个渲染器，
    // 差别只在每个元素自己的 anchor.space。
    if (cfg.elements?.length) {
      this.elements.setViewport(this.W, this.H);
      this.elements.setElements(cfg.elements).catch((e) => this.onError?.(e as Error));
    }

    // 帧效果（背景马赛克等）
    this.setupSourceEffect(cfg.source);

    // 按 perception 按需加载模型。多一个模型就是多一份内存和每帧开销，
    // 所以只加载 JSON 声明要用的。
    if (this.perception.includes("segmentation") && !this.segProvider) {
      this.loadPerception().catch((e) => this.onError?.(e as Error));
    }
    if (this.perception.includes("face")) {
      this.loadFace().catch((e) => this.onError?.(e as Error));
    }
  }

  private setupSourceEffect(source?: import("./types").SourceEffect) {
    if (!source || source.effect.kind !== "pixelate") {
      // 恢复普通视频材质
      this.bgMat = new THREE.MeshBasicMaterial({ map: this.sourceTex });
      this.bg.material = this.bgMat;
      this.maskTex?.dispose();
      this.maskTex = null;
      return;
    }
    this.onLost = source.mask.onLost ?? "clear";

    // 创建蒙版纹理（112x63，与 OccupancyField 同尺寸）
    const GW = 112, GH = 63;
    const maskData = new Uint8Array(GW * GH);
    this.maskTex = new THREE.DataTexture(maskData, GW, GH, THREE.RedFormat, THREE.UnsignedByteType);
    this.maskTex.minFilter = THREE.LinearFilter;
    this.maskTex.magFilter = THREE.LinearFilter;

    const blocks = source.effect.blocks;
    const applyOutside = source.apply === "outside";
    this.applyOutside = applyOutside;
    this.blocks = blocks;

    this.bgMat = new THREE.ShaderMaterial({
      uniforms: {
        videoTex: { value: this.sourceTex },
        maskTex: { value: this.maskTex },
        // blocks 的定义是「短边分几格」，长边按比例给更多格，块才是正方形的。
        // 两个轴都用同一个数会得到被拉长的矩形块，一眼假。resize 时同步更新。
        blocks: { value: this.blockGrid(blocks) },
        applyOutside: { value: applyOutside ? 1.0 : 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D videoTex;
        uniform sampler2D maskTex;
        uniform vec2 blocks;
        uniform float applyOutside;
        varying vec2 vUv;
        void main() {
          vec2 grid = (floor(vUv * blocks) + 0.5) / blocks;
          // 蒙版 u 镜像：与 OccupancyField.at() 的 u = 0.5 - wx/w 一致
          vec2 maskUV = vec2(1.0 - vUv.x, vUv.y);
          float m = smoothstep(0.42, 0.58, texture2D(maskTex, maskUV).r);
          vec3 pixelated = texture2D(videoTex, grid).rgb;
          vec3 sharp = texture2D(videoTex, vUv).rgb;
          // outside: 人清晰背景糊；inside: 人糊背景清晰
          vec3 color = applyOutside > 0.5
            ? mix(pixelated, sharp, m)
            : mix(sharp, pixelated, m);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    this.bg.material = this.bgMat;
  }

  /** 切模板不丢已调好的参数：调用方只覆盖新模板有的 key（PRD 4.2 非功能要求）。 */
  setControls(values: ControlValues) {
    this.controls = { ...this.controls, ...values };
  }

  setEmitterPos(x: number, y: number) {
    this.emitPos.x = Math.max(-0.48, Math.min(0.48, x));
    this.emitPos.y = Math.max(-0.3, Math.min(0.25, y));
  }

  getEmitterPos() {
    return { ...this.emitPos };
  }

  get canvasStream(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get isDegraded() {
    return this.degraded;
  }

  debugField(ctx: CanvasRenderingContext2D) {
    this.field.debugDraw(ctx);
  }

  /* ---------------- 内部 ---------------- */

  /** 短边分 n 格，长边按比例给更多格，保证每块是正方形。 */
  private blockGrid(n: number): THREE.Vector2 {
    const aspect = this.W / this.H;
    return aspect >= 1 ? new THREE.Vector2(Math.round(n * aspect), n) : new THREE.Vector2(n, Math.round(n / aspect));
  }

  private propTexture(cfg: TemplateConfig): THREE.Texture | null {
    if (!cfg.emitter) return null;
    const cached = this.propTextures.get(cfg.slug);
    if (cached) return cached;
    let tex: THREE.Texture;
    if (cfg.emitter.asset) {
      tex = new THREE.TextureLoader().load(cfg.emitter.asset);
    } else if (cfg.emitter.shape) {
      tex = new THREE.CanvasTexture(propCanvas(cfg.emitter.shape, cfg.emitter.aspect));
    } else {
      return null;
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    this.propTextures.set(cfg.slug, tex);
    return tex;
  }

  private layoutProp() {
    if (!this.cfg?.emitter) return;
    const pw = this.W * 0.24 * (this.cfg.emitter.aspect > 0.7 ? 0.85 : 1) * (this.cfg.slug === "cloud" ? 1.4 : 1);
    const ph = pw * this.cfg.emitter.aspect;
    this.prop.scale.set(pw, ph, 1);
  }

  resize() {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this.W = Math.max(2, Math.round(rect.width));
    this.H = Math.max(2, Math.round(rect.height));
    const dpr = Math.min(devicePixelRatio || 1, this.degraded ? 2 : 2.5);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.W, this.H, false);
    this.camera.left = -this.W / 2;
    this.camera.right = this.W / 2;
    this.camera.top = this.H / 2;
    this.camera.bottom = -this.H / 2;
    this.camera.updateProjectionMatrix();
    // bg 用 cover 模式：保持视频原始比例，裁掉多余部分，不拉伸
    const { w: vw, h: vh } = sourceSize(this.source, this.W, this.H);
    const viewAspect = this.W / this.H;
    const vidAspect = vw / vh;
    let bgW: number, bgH: number;
    if (vidAspect > viewAspect) {
      // 视频比容器宽，按高度匹配，左右裁
      bgH = this.H;
      bgW = this.H * vidAspect;
    } else {
      // 视频比容器窄，按宽度匹配，上下裁
      bgW = this.W;
      bgH = this.W / vidAspect;
    }
    // 镜像和占据场的 u 映射是一对，改一个就得改另一个
    this.bg.scale.set(-bgW, bgH, 1);
    // 占据场要用 cover 后的尺寸，不是 viewport 尺寸。
    // 分割遮罩覆盖整个视频帧，视频通过 cover 显示在 bgW×bgH 的区域内，
    // 粒子碰撞要对齐这个实际显示区域。
    this.field.setViewport(bgW, bgH);
    // 视口比例变了，马赛克的长边格数要跟着变，否则块会被拉长
    const shader = this.bgMat as THREE.ShaderMaterial;
    if (this.blocks && shader.uniforms?.blocks) {
      shader.uniforms.blocks.value = this.blockGrid(this.blocks);
    }
    this.particles.setPixelRatio(dpr);
    this.elements.setViewport(this.W, this.H);
    this.faceTracker.setViewport(this.W, this.H);
    this.layoutProp();
  }

  private attachDrag(canvas: HTMLCanvasElement) {
    const toNorm = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / r.width - 0.5, y: 0.5 - (ev.clientY - r.top) / r.height };
    };
    canvas.addEventListener("pointerdown", (ev) => {
      if (!this.cfg?.emitter?.draggable) return;
      const p = toNorm(ev);
      this.dragging = true;
      canvas.setPointerCapture(ev.pointerId);
      this.grab = { x: p.x - this.emitPos.x, y: p.y - this.emitPos.y };
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (!this.dragging) return;
      const p = toNorm(ev);
      this.setEmitterPos(p.x - this.grab.x, p.y - this.grab.y);
    });
    for (const t of ["pointerup", "pointercancel"] as const) {
      canvas.addEventListener(t, () => {
        this.dragging = false;
      });
    }
  }

  private runSegmentation(nowMs: number) {
    try {
      this.segProvider?.segment(this.source, nowMs, (d, w, h) => this.field.ingest(d, w, h));
    } catch (e) {
      this.onError?.(e as Error);
    }
  }

  /**
   * 手动步进一帧。离线 harness 用它按固定时刻渲染，不依赖 rAF 也不依赖挂钟。
   * t 是秒，nowMs 是毫秒——两者独立传，因为丢脸容忍用的是 ms 时间轴。
   */
  renderAt(t: number, nowMs = t * 1000) {
    this.perceive(nowMs);
    this.updateMask();
    this.elements.update(t, this.faceTracker, this.faceTracker.frame(nowMs));
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 「追踪上了没」要问当前真正在跑的那个感知，不能一律问分割。
   * facetrack 模板根本不跑分割，field.seen 恒为 false，
   * 于是脸明明已经追上了，状态栏还写着「Looking for a person…」。
   */
  private isTracking(nowMs: number): boolean {
    const face = this.perception.includes("face");
    const seg = this.perception.includes("segmentation");
    if (face && seg) return this.faceTracker.frame(nowMs) !== null || this.field.seen;
    if (face) return this.faceTracker.frame(nowMs) !== null;
    if (seg) return this.field.seen;
    return false;
  }

  private perceive(nowMs: number) {
    if (this.perception.includes("face")) this.faceTracker.detect(this.source, nowMs);
    if (this.perception.includes("segmentation")) this.runSegmentation(nowMs);
  }

  /**
   * 把占据场传成纹理。7KB 的 Float32Array 每帧转 R8 上传，开销可忽略，
   * 不要在 GPU 侧重做平滑——ingest() 里已经做过一次了。
   */
  private updateMask() {
    if (!this.maskTex) return;
    const data = this.maskTex.image.data as unknown as Uint8Array;
    if (this.field.seen) {
      for (let i = 0; i < this.field.grid.length; i++) {
        data[i] = (this.field.grid[i] * 255) | 0;
      }
    } else if (this.onLost === "hold") {
      return; // 保持上一帧蒙版，适合短暂遮挡
    } else {
      // clear = 效果哪里都不作用（人走出画面时整屏突然糊掉观感很糟）
      // full  = 效果铺满全屏
      // 蒙版值本身的含义随 apply 反转：outside 时 m=1 是「不作用」，inside 时 m=1 是「作用」
      const noEffect = this.applyOutside ? 255 : 0;
      data.fill(this.onLost === "clear" ? noEffect : 255 - noEffect);
    }
    this.maskTex.needsUpdate = true;
  }

  private loop = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);

    const t = now / 1000;
    const dt = Math.min(this.lastT ? t - this.lastT : 0.016, 0.05);
    this.lastT = t;
    if (dt <= 0) return;

    // 检测和渲染解耦：感知只在有新视频帧时跑，渲染仍然满帧。
    // 按 perception 驱动，不再按 templateType 锁死 —— 一个模板同时要人脸和分割
    // 在旧写法里根本表达不出来。
    const frameTime = this.video ? this.video.currentTime : t;
    if (frameTime !== this.lastVideoTime) {
      this.lastVideoTime = frameTime;
      this.perceive(now);
    }

    this.updateMask();

    if (this.cfg?.elements?.length) {
      this.elements.update(t, this.faceTracker, this.faceTracker.frame(now));
    }

    if (this.templateType === "particle" && this.cfg && this.cfg.emitter && this.cfg.substance) {
      const e = this.cfg.emitter;
      const pw = this.prop.scale.x;
      const ph = this.prop.scale.y;
      const ox = this.emitPos.x * this.W + e.port.x * pw;
      const oy = this.emitPos.y * this.H - e.port.y * ph;
      this.prop.position.set(this.emitPos.x * this.W, this.emitPos.y * this.H, 1);

      const { substance, knobs } = resolveControls(
        this.cfg.substance,
        this.cfg.controls,
        this.controls,
        this.degraded,
      );

      this.particles.emit(dt, knobs.rate, e, substance, pw, ph, ox, oy);
      this.particles.step(dt, t, this.field, substance, knobs.wind, knobs.stick, this.W, this.H);
    }

    this.renderer.render(this.scene, this.camera);

    this.fpsAcc += 1 / dt;
    this.fpsN++;
    if (this.fpsN >= 20) {
      this.fps = Math.round(this.fpsAcc / this.fpsN);
      this.fpsAcc = 0;
      this.fpsN = 0;
      this.onStats?.({ fps: this.fps, tracking: this.isTracking(now), degraded: this.degraded });
    }
  };
}

/** video 要 VideoTexture（每帧自动上传），静态图/canvas 用普通 Texture 上传一次。 */
function makeSourceTexture(el: FrameSource): THREE.Texture {
  const tex =
    el instanceof HTMLVideoElement ? new THREE.VideoTexture(el) : new THREE.Texture(el);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 画面源的原始像素尺寸。cover 布局要用它算比例，拿不到就退回视口尺寸。 */
function sourceSize(el: FrameSource, fallbackW: number, fallbackH: number) {
  if (el instanceof HTMLVideoElement) {
    return { w: el.videoWidth || fallbackW, h: el.videoHeight || fallbackH };
  }
  if (el instanceof HTMLImageElement) {
    return { w: el.naturalWidth || fallbackW, h: el.naturalHeight || fallbackH };
  }
  return { w: el.width || fallbackW, h: el.height || fallbackH };
}
