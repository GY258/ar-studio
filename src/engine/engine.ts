import * as THREE from "three";
import { FilesetResolver, ImageSegmenter, type ImageSegmenterResult } from "@mediapipe/tasks-vision";
import { OccupancyField } from "./occupancy";
import { ParticleSystem } from "./particles";
import { OverlayRenderer } from "./overlay-renderer";
import { FaceRenderer } from "./face-renderer";
import { propCanvas } from "./props";
import { resolveControls } from "./resolve";
import { SEG_MODEL, WASM_BASE } from "@/lib/assets";
import type { ControlValues, TemplateConfig, TemplateType } from "./types";

export interface EngineStats {
  fps: number;
  tracking: boolean;
  degraded: boolean;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
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
  private readonly video: HTMLVideoElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-640, 640, 360, -360, -100, 100);
  private readonly bg: THREE.Mesh;
  private readonly videoTex: THREE.VideoTexture;
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
  private readonly overlays: OverlayRenderer;
  private readonly faceRenderer: FaceRenderer;
  private templateType: TemplateType = "particle";
  private perception: string[] = ["segmentation"];
  private segmenter: ImageSegmenter | null = null;
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
    this.video = opts.video;
    this.onStats = opts.onStats;
    this.onError = opts.onError;

    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, preserveDrawingBuffer: false });
    this.renderer.setClearColor(0x000000, 1);

    this.videoTex = new THREE.VideoTexture(this.video);
    this.videoTex.colorSpace = THREE.SRGBColorSpace;
    this.bgMat = new THREE.MeshBasicMaterial({ map: this.videoTex });
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

    this.overlays = new OverlayRenderer(this.scene);
    this.faceRenderer = new FaceRenderer(this.scene);

    this.attachDrag(opts.canvas);
    this.resize();
  }

  /* ---------------- 生命周期 ---------------- */

  async loadPerception(): Promise<void> {
    if (this.segmenter) return;
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEG_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  }

  async loadFace(): Promise<void> {
    await this.faceRenderer.loadFaceMesh();
  }

  /** 不强制比例，让摄像头用原生分辨率，cover 模式负责显示裁剪。 */
  async startCamera(deviceId?: string): Promise<void> {
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
    const stream = this.video.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.segmenter?.close();
    this.particles.dispose();
    this.overlays.dispose();
    this.faceRenderer.dispose();
    this.propTextures.forEach((t) => t.dispose());
    this.renderer.dispose();
  }

  /* ---------------- 配置 ---------------- */

  setTemplate(cfg: TemplateConfig) {
    this.cfg = cfg;
    this.templateType = cfg.templateType ?? "particle";
    this.perception = cfg.perception ?? (this.templateType === "particle" ? ["segmentation"] : []);

    // 清理其他类型的渲染状态
    this.overlays.clear();
    this.faceRenderer.clear();
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
    } else if (this.templateType === "overlay" && cfg.overlayElements) {
      this.overlays.setViewport(this.W, this.H);
      this.overlays.setElements(cfg.overlayElements).catch((e) => this.onError?.(e as Error));
    } else if (this.templateType === "facetrack" && cfg.faceTrackElements) {
      this.faceRenderer.setViewport(this.W, this.H);
      this.faceRenderer.setElements(cfg.faceTrackElements, cfg.faceTrackAnimation).catch((e) => this.onError?.(e as Error));
      this.loadFace().catch((e) => this.onError?.(e as Error));
    }

    // 帧效果（背景马赛克等）
    this.setupSourceEffect(cfg.source);

    // 按 perception 按需加载模型
    if (this.perception.includes("segmentation") && !this.segmenter) {
      this.loadPerception().catch((e) => this.onError?.(e as Error));
    }
    if (this.perception.includes("face")) {
      this.loadFace().catch((e) => this.onError?.(e as Error));
    }
  }

  private setupSourceEffect(source?: import("./types").SourceEffect) {
    if (!source || source.effect.kind !== "pixelate") {
      // 恢复普通视频材质
      this.bgMat = new THREE.MeshBasicMaterial({ map: this.videoTex });
      this.bg.material = this.bgMat;
      this.maskTex?.dispose();
      this.maskTex = null;
      return;
    }

    // 创建蒙版纹理（112x63，与 OccupancyField 同尺寸）
    const GW = 112, GH = 63;
    const maskData = new Uint8Array(GW * GH);
    this.maskTex = new THREE.DataTexture(maskData, GW, GH, THREE.RedFormat, THREE.UnsignedByteType);
    this.maskTex.minFilter = THREE.LinearFilter;
    this.maskTex.magFilter = THREE.LinearFilter;

    const blocks = source.effect.blocks;
    const applyOutside = source.apply === "outside";

    this.bgMat = new THREE.ShaderMaterial({
      uniforms: {
        videoTex: { value: this.videoTex },
        maskTex: { value: this.maskTex },
        blocks: { value: blocks },
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
        uniform float blocks;
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
    const vw = this.video.videoWidth || this.W;
    const vh = this.video.videoHeight || this.H;
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
    this.particles.setPixelRatio(dpr);
    this.overlays.setViewport(this.W, this.H);
    this.faceRenderer.setViewport(this.W, this.H);
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
    if (!this.segmenter) return;
    const consume = (r: ImageSegmenterResult) => {
      const m = r.categoryMask;
      if (m) {
        this.field.ingest(m.getAsUint8Array(), m.width, m.height);
        m.close();
      }
      r.close?.();
    };
    try {
      this.segmenter.segmentForVideo(this.video, nowMs, consume);
    } catch (e) {
      this.onError?.(e as Error);
    }
  }

  private loop = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);

    const t = now / 1000;
    const dt = Math.min(this.lastT ? t - this.lastT : 0.016, 0.05);
    this.lastT = t;
    if (dt <= 0) return;

    // 按 perception 驱动感知，不再按 templateType 锁死
    if (this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      if (this.perception.includes("face")) {
        this.faceRenderer.detectFace(this.video, now);
      }
      if (this.perception.includes("segmentation")) {
        this.runSegmentation(now);
      }
    }

    // 更新蒙版纹理（帧效果用）
    if (this.maskTex && this.field.seen) {
      const data = this.maskTex.image.data as unknown as Uint8Array;
      for (let i = 0; i < this.field.grid.length; i++) {
        data[i] = (this.field.grid[i] * 255) | 0;
      }
      this.maskTex.needsUpdate = true;
    }

    if (this.templateType === "overlay") {
      this.overlays.update(t);
    } else if (this.templateType === "facetrack") {
      this.faceRenderer.update(t);
    } else if (this.cfg && this.cfg.emitter && this.cfg.substance) {
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
      this.onStats?.({ fps: this.fps, tracking: this.field.seen, degraded: this.degraded });
    }
  };
}
