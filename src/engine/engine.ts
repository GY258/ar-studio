import * as THREE from "three";
import { OccupancyField } from "./occupancy";
import { MaskField } from "./mask-field";
import {
  MediaPipeSegmentationProvider,
  type SegmentationProvider,
} from "./segmentation";
import { ParticleSystem } from "./particles";
import { ElementRenderer } from "./element-renderer";
import {
  FaceTracker,
  MediaPipeLandmarkProvider,
  faceOval,
  type FrameSource,
  type LandmarkProvider,
} from "./face-tracker";
import { HandTracker, MediaPipeHandProvider, type HandLandmarkProvider } from "./hand-tracker";
import { PoseTracker, MediaPipePoseProvider, type PoseLandmarkProvider } from "./pose-tracker";
import { propCanvas } from "./props";
import { resolveControls } from "./resolve";
import { parseElementTarget } from "./tunables";
import { EFFECT_COMBINE, EFFECT_SNIPPETS } from "./source-effects";
import type { ControlValues, TemplateConfig, TemplateType } from "./types";

/**
 * 状态推进的定步长，秒。
 *
 * 1/60 而不是跟着真实帧率：轨迹这类跨帧状态一旦依赖 dt，
 * 同一段输入在快机器和慢机器上就会算出不同结果，golden 立刻失效。
 */
const SIM_STEP = 1 / 60;

/**
 * 手机上检测最多每秒跑几次。
 *
 * 20 是个折中：一帧姿态检测在手机上要二三十毫秒，30fps 全跑等于把主线程占满；
 * 而低于 15 的话快速动作会看出覆盖层「跟不上手」。
 * 桌面不限速 —— 那边一帧检测几毫秒，限了反而白白丢精度。
 */
const DETECT_HZ_MOBILE = 20;

export interface EngineStats {
  fps: number;
  tracking: boolean;
  degraded: boolean;
  /**
   * 这个模板需不需要追踪。
   *
   * 不需要感知的模板（raindrops 这种纯屏幕空间贴纸）**没有东西可追**，
   * 而 tracking 只能是 true/false 两个值 —— 于是状态栏永远显示
   * 「Looking for a person…」，看着像检测坏了。
   * 把「不适用」和「没追上」分开，UI 才有可能说对话。
   */
  needsTracking: boolean;
  /**
   * 摄像头**实际**给的分辨率和帧率，形如 "1080x1920@30"。
   *
   * 显示出来是为了让「缩放不对」「掉帧」这类反馈能落到具体数字上 ——
   * 请求什么和拿到什么经常对不上，而只看画面根本分不清是取景问题
   * 还是比例算错了。
   */
  camera: string;
  /** 当前缩放倍率。UI 靠它让档位按钮跟着捏合走 —— 两套控件不同步的话
   *  捏完之后高亮的还是旧档位，看着像坏了 */
  zoom: number;
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
  /** 帧效果专用的高分辨率蒙版。粒子那套 112×63 的场太粗，抠图会露台阶 */
  private readonly maskField = new MaskField();
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
  private readonly handTracker = new HandTracker();
  private readonly poseTracker = new PoseTracker();
  private templateType: TemplateType = "particle";
  private perception: string[] = ["segmentation"];
  private segProvider: SegmentationProvider | null = null;
  /** 丢人兜底策略，来自 source.mask.onLost */
  private onLost: "clear" | "hold" | "full" = "clear";
  private applyOutside = true;
  /** 画面是不是镜像的。前置摄像头是（自拍看着才自然），后置不是 */
  private mirrored = true;
  /**
   * 摄像头**实际**给了什么，不是我们请求了什么。
   *
   * 这两个经常对不上：手机可能忽略 ideal 直接给自己的档位，也可能给一个
   * 带旋转的横向流（videoWidth/Height 是横的，画面却是竖的）——
   * 后者会让 cover 的比例算错，表现就是「缩放不对」。
   * 猜是猜不出来的，所以把它显示出来。
   */
  private camInfo = "";
  /** 设备**支持**什么（不是这次拿到了什么）。见 startCamera 里的注释 */
  private camCaps = "";
  /**
   * 数字缩放倍率。1 = 原始取景。
   *
   * 为什么自己做而不是用摄像头的硬件变焦：`track.getCapabilities().zoom`
   * 在 **iOS Safari 上不支持**（Android Chrome 才有）。而整条渲染管线在我们手里 ——
   * 背景平面放大多少，归一化坐标转世界坐标就跟着放大多少，元素自然还贴在人身上。
   *
   * 代价是**数字缩放不增加细节**：放大 2 倍就是把像素放大 2 倍。
   * 不过摄像头给的是 1080 宽、屏幕才 390pt，有足够余量。
   */
  private zoom = 1;
  /** source.effect.blocks，短边格数。resize 时要按新比例重算长边格数 */
  private blocks = 0;
  /** source.effect.radius，归一化到长边。resize 时要按新比例重算 uv 步长 */
  private blurRadius = 0;
  /** source.mask.exclude === "face" */
  private excludeFace = false;
  private excludePadding = 1;
  /** 注入进背景材质的 uniform 引用，onBeforeCompile 时拿到 */
  private bgUniforms: Record<string, { value: unknown }> | null = null;
  private raf = 0;
  /** 模拟到了哪个时刻，秒。-1 = 还没开始 */
  private simT = -1;
  private lastT = 0;
  private lastVideoTime = -1;
  /** 上一次真正跑检测的时刻，秒。手机上用它限速 */
  private lastDetectT = -1e9;
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
    this.elements.setSourceTexture(this.sourceTex);

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
    // 有没有帧效果，背景材质都是 MeshBasicMaterial，贴图都挂在 map 上
    const mat = this.bgMat as THREE.MeshBasicMaterial;
    mat.map = this.sourceTex;
    mat.needsUpdate = true;
    // 泡泡的折射要采这张。不同步的话泡泡里是上一张画面 ——
    // 离线 harness 每换一个 fixture 都会走这条路
    this.elements.setSourceTexture(this.sourceTex);
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

  /** 注入手部来源。不调用则用 MediaPipe，测试里注入 fixture 回放。 */
  setHandProvider(p: HandLandmarkProvider) {
    this.handTracker.setProvider(p);
  }

  /** 注入姿态来源。不调用则用 MediaPipe，测试里注入 fixture 回放。 */
  setPoseProvider(p: PoseLandmarkProvider) {
    this.poseTracker.setProvider(p);
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

  async loadPose(): Promise<void> {
    if (this.poseTracker.hasProvider()) return; // 已注入 fixture provider 就别再拉模型
    const provider = new MediaPipePoseProvider();
    await provider.load();
    this.poseTracker.setProvider(provider);
  }

  async loadHands(): Promise<void> {
    if (this.handTracker.hasProvider()) return; // 已注入 fixture provider 就别再拉模型
    const provider = new MediaPipeHandProvider();
    await provider.load();
    this.handTracker.setProvider(provider);
  }

  async loadFace(): Promise<void> {
    if (this.faceTracker.hasProvider()) return; // 已注入 fixture provider 就别再拉模型
    const provider = new MediaPipeLandmarkProvider();
    await provider.load();
    this.faceTracker.setProvider(provider);
  }

  /** 不强制比例，让摄像头用原生分辨率，cover 模式负责显示裁剪。 */
  /**
   * 开摄像头。
   *
   * facing 决定用前置还是后置，**同时决定画面镜不镜像**：
   * 前置自拍不镜像的话抬左手看着是右手动，人立刻别扭；
   * 后置拍别人镜像了则整个世界左右反了。
   *
   * 镜像这一位会一路传到元素定位、占据场、泡泡折射 ——
   * 漏掉任何一处的表现都是「贴在了镜像的位置上」，而且**只有换到后置才看得出来**。
   * 所以这里只设一个 setMirrored，具体换算集中在各自的一个函数里。
   */
  async startCamera(facing: "user" | "environment" = "user", deviceId?: string): Promise<void> {
    if (!this.video) throw new Error("startCamera 需要一个 video 元素；离线模式请用 setSource()");
    this.degraded = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
    this.stopCamera();
    /*
     * 手机上请求**竖向**分辨率。
     *
     * 原来一律要 4:3 横向（1280×960），而手机画布是 9:16 竖屏 ——
     * cover 裁切会把两侧砍掉一大半，人直接被切成半边。
     * 全身类模板（fluidity）在这个裁法下根本框不进一个人。
     *
     * 用 ideal 而不是 exact：拿不到竖向流的设备会退回它自己的最佳档，
     * 而不是直接抛 OverconstrainedError 让整个页面开不了摄像头。
     */
    const portrait = this.degraded;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: portrait ? 1080 : 1920 },
        height: { ideal: portrait ? 1920 : 1080 },
        facingMode: facing,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      audio: false,
    });
    this.setMirrored(facing === "user");
    this.video.srcObject = stream;
    await this.video.play();
    /*
     * 记下**实际拿到的**和**设备到底支持什么**。
     *
     * 「iOS 给不了竖向流」这个结论不该从一次观察推出来 —— ideal 只是偏好，
     * 浏览器按自己的距离函数挑最近的档位，而 1080x1920 和 1920x1080
     * 像素数完全一样，「最近」这件事上是平手，于是它保持了原生方向。
     * 真正能证明「给不了」的是 getCapabilities()：它列出设备支持的
     * 宽高范围和长宽比范围。竖向档位存不存在，看那个才知道。
     */
    const track = stream.getVideoTracks()[0];
    const st = track?.getSettings?.();
    if (st) this.camInfo = `${st.width}x${st.height}@${Math.round(st.frameRate ?? 0)}`;
    const caps = track?.getCapabilities?.() as
      | { width?: { max?: number }; height?: { max?: number }; aspectRatio?: { min?: number; max?: number } }
      | undefined;
    if (caps?.aspectRatio) {
      // 长宽比下限小于 1 就说明设备**能**给竖向流，那样的话该改约束而不是让用户缩
      this.camCaps = `ar ${caps.aspectRatio.min?.toFixed(2) ?? "?"}~${caps.aspectRatio.max?.toFixed(2) ?? "?"}`;
    } else if (caps?.width?.max) {
      this.camCaps = `max ${caps.width.max}x${caps.height?.max ?? "?"}`;
    }
    // videoWidth/videoHeight 在 play 后才可靠，再 resize 一次确保 cover 比例正确
    this.video.addEventListener("loadedmetadata", () => this.resize(), { once: true });
    this.resize();
  }

  /** 关掉当前的摄像头轨道。切前后置时必须先关，否则有的手机拿不到第二个流 */
  private stopCamera() {
    const st = this.video?.srcObject as MediaStream | null;
    st?.getTracks().forEach((t) => t.stop());
    if (this.video) this.video.srcObject = null;
  }

  /** 画面是不是镜像的。只有 startCamera 该调它 —— 它和摄像头朝向是一回事 */
  setMirrored(m: boolean) {
    this.mirrored = m;
    this.elements.setMirror(m);
    this.field.setMirror(m);
    this.resize();
  }

  isMirrored(): boolean {
    return this.mirrored;
  }

  /**
   * 设置数字缩放。**允许小于 1**。
   *
   * 实测 iOS 会忽略「请求竖向分辨率」直接给 1920x1080 的横向流
   * （状态栏里显示的就是这个数）。竖屏画布 cover 之后只显示视频宽度的 26% ——
   * 这就是「取景比系统相机窄得多」的全部原因，不是比例算错。
   *
   * 拿不到竖向流就只能让用户往回缩：0.5 倍时能看到接近两倍宽的场景，
   * 代价是上下出现黑边。这和系统相机的 0.5x 是同一个意思 ——
   * 那边是切到超广角镜头，这边是把画面缩回来，观感目的一样。
   *
   * 下限 0.3：再小主体已经小到没法用，而黑边占了大半个屏幕。
   */
  setZoom(z: number) {
    const next = Math.max(0.3, Math.min(4, z));
    if (next === this.zoom) return;
    this.zoom = next;
    this.elements.setZoom(next);
    this.field.setZoom(next);
    this.resize();
  }

  getZoom(): number {
    return this.zoom;
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
    this.handTracker.dispose();
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
    // 脸部保护也要人脸。校验器会要求 JSON 显式声明，这里是拿数据库模板兜底
    if (cfg.source?.mask.exclude === "face" && !this.perception.includes("face")) {
      this.perception.push("face");
    }
    // 有 hand 空间元素就要手部感知，同样兜底
    if (cfg.elements?.some((e) => e.anchor.space === "hand") && !this.perception.includes("hands")) {
      this.perception.push("hands");
    }

    // 清理其他类型的渲染状态
    this.elements.clear();
    this.resetSim();
    this.faceTracker.reset();
    this.handTracker.reset();
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
    this.poseTracker.setViewport(this.W, this.H);
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
    if (this.perception.includes("hands")) {
      this.loadHands().catch((e) => this.onError?.(e as Error));
    }
    if (this.perception.includes("pose")) {
      this.loadPose().catch((e) => this.onError?.(e as Error));
    }

    // 元素刚建好，把当前滑块值推一遍。不推的话滑块显示的是 default，
    // 而元素用的是 JSON 里的初值 —— 两者不一致时要拖一下才「对上」
    this.elements.ready().then(() => this.setControls(this.controls));
  }

  private setupSourceEffect(source?: import("./types").SourceEffect) {
    if (!source || !EFFECT_SNIPPETS[source.effect.kind]) {
      // 恢复普通视频材质
      this.bgMat = new THREE.MeshBasicMaterial({ map: this.sourceTex });
      this.bg.material = this.bgMat;
      this.bgUniforms = null;
      this.blocks = 0;
      this.blurRadius = 0;
      this.excludeFace = false;
      this.maskTex?.dispose();
      this.maskTex = null;
      return;
    }
    this.onLost = source.mask.onLost ?? "clear";
    this.excludeFace = source.mask.exclude === "face";
    this.excludePadding = source.mask.excludePadding ?? 1;
    this.maskField.setFeather(source.mask.feather ?? 0);
    this.maskField.reset();
    // 纹理尺寸跟 maskField 走，而 maskField 的尺寸要等第一帧 mask 才知道，
    // 所以这里先给一个 1x1 占位，updateMask 里发现尺寸对不上再重建。
    this.maskTex = makeMaskTexture(1, 1);

    const effect = source.effect;
    const applyOutside = source.apply === "outside";
    this.applyOutside = applyOutside;
    // voxel 和 pixelate 共用同一个网格轴：blocks = 短边格数。
    // 这样 resize 的重算逻辑（blockGrid）也一并复用，块永远是正方形的
    this.blocks =
      effect.kind === "pixelate" || effect.kind === "pixel-art" || effect.kind === "voxel" ? effect.blocks : 0;
    this.blurRadius = effect.kind === "blur" ? effect.radius : 0;

    /*
     * 往内置 MeshBasicMaterial 里注入，而不是自己写一个裸 ShaderMaterial。
     *
     * 裸 shader 在色彩管理上会踩坑：three 给视频纹理做 sRGB→线性 是在**着色器里**
     * 补的（内置材质带 DECODE_VIDEO_TEXTURE 这个宏），因为视频纹理拿不到硬件 sRGB 解码；
     * 而图片纹理走的是硬件解码。裸 shader 两个宏都吃不到，于是同一份代码
     * 在图片源上颜色正确、在摄像头源上整体偏亮一次 sRGB 编码。
     *
     * 挂到内置材质上，采样和输出两端的色彩转换都交给 three，
     * 有效果和没效果两条路的颜色就永远一致。
     */
    const mat = new THREE.MeshBasicMaterial({ map: this.sourceTex });

    /*
     * 必须给出 program 缓存 key，否则切模板时会拿到上一个效果的 shader。
     *
     * three 缓存编译好的 program，key 默认是 material.customProgramCacheKey()，
     * 而它的默认实现是 onBeforeCompile.toString()。我们这个函数的**源码文本永远一样**
     * —— 效果片段是 ${EFFECT_SNIPPETS[kind]} 在运行时插进模板字符串的，不出现在函数源码里。
     * 于是 three 认为 pixelate 和 desaturate 是同一个 shader，直接复用先编译的那个。
     *
     * 表现极具迷惑性，而且方向取决于先开了哪个模板：
     *   先 desaturate 后 pixelate → 跑 desaturate 的 shader，amount=0 → 画面完全不变，
     *                                看着像「马赛克没开」
     *   先 pixelate 后 desaturate → 跑 pixelate 的 shader，blocks=(0,0) → 1.0/0.0 → NaN uv
     *                                → 整片背景变成一块死平色
     * 两种都不报错。硬刷新之后「好了」，是因为刷新后第一个编译的恰好是它。
     *
     * 这个坑是加第二种 effect.kind 的那一刻才出现的 —— 在只有 pixelate 的年代，
     * 所有模板本来就该共用同一个 program。
     */
    mat.customProgramCacheKey = () => `ar-source-effect:${effect.kind}`;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.maskTex = { value: this.maskTex };
      // blocks 的定义是「短边分几格」，长边按比例给更多格，块才是正方形的。
      // 两个轴都用同一个数会得到被拉长的矩形块，一眼假。resize 时同步更新。
      shader.uniforms.blocks = { value: this.blockGrid(this.blocks) };
      shader.uniforms.blurStep = { value: this.blurStep(this.blurRadius) };
      shader.uniforms.amount = { value: effect.kind === "desaturate" ? effect.amount : 0 };
      shader.uniforms.applyOutside = { value: applyOutside ? 1.0 : 0.0 };
      // 过渡带往哪边推。0.12 ≈ 把整条过渡带挪出人体轮廓，见下面的注释
      shader.uniforms.maskBias = { value: applyOutside ? 0.12 : -0.12 };
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.faceOval = { value: new THREE.Vector4(0.5, 0.5, 0, 0) };
      shader.uniforms.faceProtect = { value: 0 };
      const g = effect.kind === "glitch" ? effect : null;
      shader.uniforms.gBlocks = { value: g?.blocks ?? 48 };
      shader.uniforms.gDisplace = { value: g?.displace ?? 0 };
      shader.uniforms.gChannelSplit = { value: g?.channelSplit ?? 0 };
      shader.uniforms.gScanline = { value: g?.scanline ?? 0 };
      shader.uniforms.gColorNoise = { value: g?.colorNoise ?? 0 };
      shader.uniforms.gDarkBias = { value: g?.darkBias ?? 0 };
      shader.uniforms.gSpeed = { value: g?.speed ?? 1 };
      shader.uniforms.gSeed = { value: g?.seed ?? 0 };
      const v = effect.kind === "voxel" ? effect : null;
      shader.uniforms.vPalette = { value: v?.palette ?? 0 };
      shader.uniforms.vLevels = { value: v?.levels ?? 6 };
      shader.uniforms.vSat = { value: v?.saturate ?? 0.35 };
      shader.uniforms.vFaceShade = { value: v?.faceShade ?? 0 };
      shader.uniforms.vOutline = { value: v?.outline ?? 0 };
      shader.uniforms.vGrain = { value: v?.grain ?? 0 };
      shader.uniforms.vAmbient = { value: v?.ambient ?? 0.02 };
      shader.uniforms.vSmooth = { value: v?.smooth ?? 0.65 };
      shader.uniforms.vSeed = { value: v?.seed ?? 0 };

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform sampler2D maskTex;
          uniform vec2 blocks;
          uniform vec2 blurStep;
          uniform float amount;
          uniform float applyOutside;
          uniform float maskBias;
          // 时间。由 renderAt(t) / loop() 传的同一个 t 驱动，不读挂钟 ——
          // 读挂钟的话「同一份输入渲染多少次都是同一张图」就不成立了
          uniform float uTime;
          uniform float gBlocks;
          uniform float gDisplace;
          uniform float gChannelSplit;
          uniform float gScanline;
          uniform float gColorNoise;
          uniform float gDarkBias;
          uniform float gSpeed;
          uniform float gSeed;
          uniform float vPalette;
          uniform float vLevels;
          uniform float vSat;
          uniform float vFaceShade;
          uniform float vOutline;
          uniform float vGrain;
          uniform float vAmbient;
          uniform float vSmooth;
          uniform float vSeed;
          /** 脸部保护椭圆，蒙版空间（y 向下）。xy = 中心，zw = 半径 */
          uniform vec4 faceOval;
          /** 0 = 不保护。丢脸时也置 0，让效果照常作用而不是整片突然恢复 */
          uniform float faceProtect;

          /** 确定性 hash。glitch 的每一处随机都走它，不许出现真随机数 */
          float arHash(vec2 p, float seed) {
            p = fract(p * vec2(123.34, 456.21) + seed * 0.017);
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
          }`,
        )
        /*
         * 辅助函数挂在 <map_pars_fragment> 后面，不能挂在 <common> 后面：
         * map 这个 sampler 是 <map_pars_fragment> 声明的，而它排在 <common> 之后。
         * 挂错位置的表现是整个 shader 编译失败 → 材质变黑 → 一整帧全黑，
         * 而 three 只在控制台打一行，测试里看到的现象是「清晰区面积为 0」。
         */
        .replace(
          "#include <map_pars_fragment>",
          `#include <map_pars_fragment>
          /*
           * 取一个纹素并补上 three 对视频纹理的 sRGB→线性 解码。
           *
           * 每个 kind 都要对自己那份纹素补这一下，漏一个的表现是「有效果的区域偏亮」，
           * 而且**只在摄像头源上出现** —— 离线 harness 用的是图片源，走硬件解码，
           * 逐像素断言全都照过。所以这件事必须收口成一个函数，不能靠每处手抄。
           */
          /*
           * 采一次蒙版并做完阈值。收口成函数是因为马赛克要在块内多点采样，
           * 每个采样点都得问一次「这里是不是人」—— 复制三遍那段翻转 + smoothstep
           * 迟早会漏改一处，而漏改的表现是边界莫名其妙偏一点，最难查。
           *
           * 蒙版要上下翻一次再采：画面源是 image / video，three 给它 flipY = true，
           * 上传时翻了一次；蒙版是 DataTexture，three 的默认是 flipY = false，没翻。
           * 同一个 uv 在两张纹理上指的是上下相反的两行。
           *
           * 这和水平镜像是两回事：背景平面的 scale.x = -1 已经把画面和蒙版一起翻了，
           * x 这一路**不要**再补，补了人偏左时清晰区会跑到右边去。
           *
           * 过渡带整体挪到吃效果的那一侧（maskBias），不能骑在边界上：
           * 对称过渡意味着人的轮廓内侧混着背景的效果，blocks 大的时候
           * 一整块糊斑贴在肩膀上。
           */
          float maskAt(vec2 uv) {
            vec2 mUv = vec2(uv.x, 1.0 - uv.y);
            float mv = smoothstep(0.42 - maskBias, 0.58 - maskBias, texture2D(maskTex, mUv).r);

            /*
             * 脸部保护：把脸从「效果作用的区域」里挖掉。
             *
             * 挖的是**效果强度**不是原始蒙版值，所以两种 apply 的极性是相反的：
             *   inside （效果在人身上）→ 脸上要 m = 0
             *   outside（效果在背景）  → 脸上要 m = 1（1 才是「保持原样」）
             * 写成一个 max/min 而不是各写一份，是为了以后加第三种 apply 时不用再改这里。
             *
             * 边缘用 smoothstep 羽化：硬边会在脸的轮廓上留一圈明显的分界，
             * 比脸上有点花还难看。
             */
            if (faceProtect > 0.5) {
              vec2 d = (mUv - faceOval.xy) / max(vec2(1e-4), faceOval.zw);
              float inFace = 1.0 - smoothstep(0.78, 1.0, length(d));
              mv = applyOutside > 0.5 ? max(mv, inFace) : mv * (1.0 - inFace);
            }
            return mv;
          }

          vec4 srcTexel(vec2 uv) {
            vec4 c = texture2D( map, uv );
            #ifdef DECODE_VIDEO_TEXTURE
              c = vec4( mix( pow( c.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), c.rgb * 0.0773993808, vec3( lessThanEqual( c.rgb, vec3( 0.04045 ) ) ) ), c.w );
            #endif
            return c;
          }`,
        )
        .replace(
          "#include <map_fragment>",
          `
          vec4 sharpTexel = srcTexel( vMapUv );
          float m = maskAt( vMapUv );
          // m 在效果片段之前算好：马赛克要按人/背景加权取样，得先知道蒙版
          ${EFFECT_SNIPPETS[effect.kind]}
          ${
            EFFECT_COMBINE[effect.kind] ??
            // outside: 人保持原样、背景吃效果；inside: 反过来
            "diffuseColor *= applyOutside > 0.5 ? mix(effectTexel, sharpTexel, m) : mix(sharpTexel, effectTexel, m);"
          }
          `,
        );

      // 留着引用，resize 要改 blocks / blurStep，蒙版换尺寸要改 maskTex
      this.bgUniforms = shader.uniforms as Record<string, { value: unknown }>;
    };

    this.bgMat = mat;
    this.bg.material = this.bgMat;
  }

  /** 切模板不丢已调好的参数：调用方只覆盖新模板有的 key（PRD 4.2 非功能要求）。 */
  setControls(values: ControlValues) {
    this.controls = { ...this.controls, ...values };
    /*
     * 元素参数的滑块在这里分发。
     *
     * particle 那条线是每帧在渲染循环里 resolveControls 一次，而元素参数
     * 没必要每帧解算 —— 拖动时才变，直接推到对应的 field 上就行。
     * 顺带这也是 `controls` 对非 particle 模板从「静默失效」变成真的有用的那一步。
     */
    for (const c of this.cfg?.controls ?? []) {
      const v = values[c.key];
      if (typeof v !== "number" || !c.target) continue;
      const et = parseElementTarget(c.target);
      if (et) this.elements.setElementParam(et.elementId, et.param, v);
    }
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

  /**
   * 背景材质的类型名。测试用它钉住一个架构决定：
   * 帧效果必须挂在内置材质上（onBeforeCompile 注入），不能换回裸 ShaderMaterial。
   * 裸 shader 吃不到 three 的 DECODE_VIDEO_TEXTURE，摄像头源上颜色会整体偏亮，
   * 而离线 harness 用的是图片源，这个 bug 在测试里根本复现不出来。
   */
  /**
   * 渲染循环的实时状态。smoke:live 靠它判断「起来了没、追踪上没」——
   * 读状态栏文字太脆（文案一改就断），读引擎自己的数才是可靠的。
   */
  debugStats() {
    return {
      fps: this.fps,
      needsTracking: this.perception.length > 0,
      tracking: this.isTracking(performance.now()),
      degraded: this.degraded,
      camera: this.camInfo,
      zoom: this.zoom,
      perception: this.perception.join(","),
      templateType: this.templateType,
      elementCount: this.elements.count(),
      /**
       * 元素组里实际有多少个 Object3D。
       *
       * 和 elementCount 分开报，因为一个元素可能拥有多个 mesh（轨迹的叶子池、
       * 绽放的花池）。**切模板后这个数没回落就是泄漏了** ——
       * 而泄漏出来的东西当时可能刚好是隐藏的，像素断言抓不到。
       */
      elementObjects: this.elements.objectCount(),
      bubblesAlive: this.elements.bubbleAlive(),
      fluidityBoxes: this.elements.fluidityBoxes(),
      fluidityLowestY: this.elements.fluidityLowestY(),
      fluidityRate: this.elements.fluidityRate(),
      fluidityOutsideLines: this.elements.fluidityOutsideLines(),
      /**
       * 解不出素材、被跳过的元素。**非空就是有东西没画出来**。
       * smoke:live 据此判失败 —— 这个失效模式以前是完全静默的。
       */
      missingAssets: [...this.elements.missing()],
    };
  }

  /**
   * 蒙版这一路的实时状态。排查「效果没生效」时的第一手证据。
   *
   * 「整幅画面都没效果」和「效果作用错了地方」是两类完全不同的故障：
   * 前者多半是 seen=false 走了 onLost 兜底（整张蒙版被填成「哪里都不作用」），
   * 后者才是蒙版本身的问题。光看画面区分不了，看这几个数字一眼就知道。
   */
  /** 摄像头能力。诊断「竖向流到底是给不了还是没要对」用 */
  debugCameraCaps(): string {
    return this.camCaps;
  }

  debugMaskStats() {
    const src = this.maskField.data;
    let min = 255;
    let max = 0;
    let sum = 0;
    if (src) {
      for (let i = 0; i < src.length; i++) {
        const v = src[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
    }
    return {
      seen: this.maskField.seen,
      maskSize: `${this.maskField.width}x${this.maskField.height}`,
      texSize: this.maskTex ? `${this.maskTex.image.width}x${this.maskTex.image.height}` : "无",
      // 0~255。整张都是 255 且 seen=false 就是走了兜底，效果当然哪里都不作用
      min,
      max,
      mean: src?.length ? +(sum / src.length).toFixed(1) : null,
      onLost: this.onLost,
      applyOutside: this.applyOutside,
      blocks: this.bgUniforms?.blocks?.value ?? null,
      effect: this.cfg?.source?.effect.kind ?? "无",
      perception: this.perception.join(","),
    };
  }

  debugBgMaterialType(): string {
    return this.bgMat.type;
  }

  /* ---------------- 内部 ---------------- */

  /** 短边分 n 格，长边按比例给更多格，保证每块是正方形。 */
  private blockGrid(n: number): THREE.Vector2 {
    const aspect = this.W / this.H;
    return aspect >= 1 ? new THREE.Vector2(Math.round(n * aspect), n) : new THREE.Vector2(n, Math.round(n / aspect));
  }

  /**
   * 模糊半径（长边的比例）→ 两个轴各自的 uv 步长。
   *
   * uv 两个轴的物理长度不一样，直接把同一个数当步长会得到被拉长的模糊 ——
   * 和 blocks 那个坑是同一个，所以同样要挂在 resize 上。
   */
  private blurStep(radius: number): THREE.Vector2 {
    if (radius <= 0) return new THREE.Vector2(0, 0);
    const long = Math.max(this.W, this.H);
    return new THREE.Vector2((radius * long) / this.W, (radius * long) / this.H);
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
    /*
     * 缩放作用在背景平面上，元素那边走 nx2wx 用同一个倍率 ——
     * 两边必须同步，否则放大之后框会从人身上滑开。
     */
    const z = this.zoom;
    this.bg.scale.set((this.mirrored ? -bgW : bgW) * z, bgH * z, 1);
    // 占据场要用 cover 后的尺寸，不是 viewport 尺寸。
    // 分割遮罩覆盖整个视频帧，视频通过 cover 显示在 bgW×bgH 的区域内，
    // 粒子碰撞要对齐这个实际显示区域。
    this.field.setViewport(bgW, bgH);
    // 视口比例变了，马赛克的长边格数和模糊的 uv 步长都要跟着变，否则会被拉长
    if (this.blocks && this.bgUniforms?.blocks) {
      this.bgUniforms.blocks.value = this.blockGrid(this.blocks);
    }
    if (this.blurRadius && this.bgUniforms?.blurStep) {
      this.bgUniforms.blurStep.value = this.blurStep(this.blurRadius);
    }
    this.particles.setPixelRatio(dpr);
    this.elements.setViewport(this.W, this.H);
    this.poseTracker.setViewport(this.W, this.H);
    this.faceTracker.setViewport(this.W, this.H);
    this.handTracker.setViewport(this.W, this.H);
    this.layoutProp();
  }

  /**
   * 指针交互。两类目标共用一套手势：
   *   - 声明了 interactive 的元素（画质菜单这种，用户自己摆位置和大小）
   *   - particle 模板的发射器道具
   * 元素优先——它画在最上面，点它的时候不该穿透到底下的道具。
   */
  private attachDrag(canvas: HTMLCanvasElement) {
    const toNorm = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / r.width - 0.5, y: 0.5 - (ev.clientY - r.top) / r.height };
    };
    // 世界坐标和元素的 mesh.position 同一套：原点在中心，y 向上
    const toWorld = (ev: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: ((ev.clientX - r.left) / r.width - 0.5) * this.W,
        y: (0.5 - (ev.clientY - r.top) / r.height) * this.H,
      };
    };

    let grabbed: ReturnType<ElementRenderer["hitTest"]> = null;
    let lastPointer = { x: 0, y: 0 };



    canvas.addEventListener("pointerdown", (ev) => {
      const w = toWorld(ev);
      grabbed = this.elements.hitTest(w.x, w.y);
      if (grabbed?.elem.interactive?.drag) {
        canvas.setPointerCapture(ev.pointerId);
        lastPointer = w;
        return;
      }
      grabbed = null;

      if (!this.cfg?.emitter?.draggable) return;
      const p = toNorm(ev);
      this.dragging = true;
      canvas.setPointerCapture(ev.pointerId);
      this.grab = { x: p.x - this.emitPos.x, y: p.y - this.emitPos.y };
    });

    canvas.addEventListener("pointermove", (ev) => {
      if (grabbed) {
        const w = toWorld(ev);
        this.elements.moveBy(grabbed, w.x - lastPointer.x, w.y - lastPointer.y);
        lastPointer = w;
        return;
      }
      if (!this.dragging) return;
      const p = toNorm(ev);
      this.setEmitterPos(p.x - this.grab.x, p.y - this.grab.y);
    });

    for (const t of ["pointerup", "pointercancel"] as const) {
      canvas.addEventListener(t, () => {
        this.dragging = false;
        grabbed = null;
      });
    }

    canvas.addEventListener(
      "wheel",
      (ev) => {
        const w = toWorld(ev);
        const hit = this.elements.hitTest(w.x, w.y);
        if (!hit?.elem.interactive?.resize) return;
        // 只有真的命中了可缩放元素才吃掉滚轮，否则页面就滚不动了
        ev.preventDefault();
        // 按滚动量成比例，不是每个事件走固定一档：鼠标滚轮一格 deltaY ≈ 100，
        // 触控板一次滑动可能只发一个 deltaY 很大的事件，固定档位会让它几乎没反应。
        // 单次夹在 0.5~2 倍，防止触控板猛甩一下直接缩没。
        const factor = Math.min(2, Math.max(0.5, Math.exp(-ev.deltaY * 0.0015)));
        this.elements.zoomBy(hit, factor);
      },
      { passive: false },
    );

    /*
     * 触屏双指捏合，两种含义共存：
     *   捏在**可缩放的道具**上 → 缩那个道具（原有行为，粒子模板的喷头）
     *   捏在**别处**           → 缩整个画面，和系统相机一个手势
     *
     * 按落点区分而不是加个模式开关：用户不该先想「我现在要缩什么」。
     * 道具是稀疏的几个，捏中它的概率本来就低，所以「别处」是绝大多数情况。
     *
     * passive: false 是必须的 —— 不 preventDefault 的话 Safari 会把捏合
     * 当成页面缩放，整个 UI 跟着放大。
     */
    let pinchStart = 0;
    let pinchTarget: ReturnType<ElementRenderer["hitTest"]> = null;
    let zoomStart = 1;
    const touchDist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    canvas.addEventListener(
      "touchstart",
      (ev) => {
        if (ev.touches.length !== 2) return;
        ev.preventDefault();
        const r = canvas.getBoundingClientRect();
        const mx = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
        const my = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
        const hit = this.elements.hitTest(
          ((mx - r.left) / r.width - 0.5) * this.W,
          (0.5 - (my - r.top) / r.height) * this.H,
        );
        pinchTarget = hit?.elem.interactive?.resize ? hit : null;
        pinchStart = touchDist(ev.touches);
        zoomStart = this.zoom;
      },
      { passive: false },
    );
    canvas.addEventListener(
      "touchmove",
      (ev) => {
        if (ev.touches.length !== 2 || pinchStart === 0) return;
        ev.preventDefault();
        const d = touchDist(ev.touches);
        if (pinchTarget) {
          // 道具：按增量缩，所以每次更新基准
          this.elements.zoomBy(pinchTarget, d / pinchStart);
          pinchStart = d;
        } else {
          // 画面：按**起始距离**算绝对倍率，手指来回捏不会累积漂移
          this.setZoom(zoomStart * (d / pinchStart));
        }
      },
      { passive: false },
    );
    canvas.addEventListener("touchend", () => {
      pinchTarget = null;
      pinchStart = 0;
    });
  }

  private runSegmentation(nowMs: number) {
    try {
      this.segProvider?.segment(this.source, nowMs, (d, w, h) => {
        // 两个场吃同一份原始 mask，各自按自己的用途处理：
        // 占据场给粒子碰撞（粗且重平滑），蒙版场给帧效果（细且跟手）。
        this.field.ingest(d, w, h);
        if (this.maskTex) this.maskField.ingest(d, w, h);
      });
    } catch (e) {
      this.onError?.(e as Error);
    }
  }

  /**
   * 手动步进一帧。离线 harness 用它按固定时刻渲染，不依赖 rAF 也不依赖挂钟。
   * t 是秒，nowMs 是毫秒——两者独立传，因为丢脸容忍用的是 ms 时间轴。
   */
  renderAt(t: number, nowMs = t * 1000) {
    this.advance(t, nowMs);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 推进到时刻 t，但不渲染。感知、蒙版、元素状态都在这里更新。
   *
   * 和 renderAt 分开是为了 stepTo：有跨帧状态之后，「渲染 t 时刻」不再等于
   * 「把所有东西设成 t 时刻的值」，而是「从当前时刻一步步走到 t」。
   */
  private advance(t: number, nowMs = t * 1000) {
    this.perceive(nowMs);
    this.updateMask();
    this.setEffectTime(t);
    this.setFaceProtect(nowMs);
    this.elements.update(
      t,
      this.faceTracker,
      this.faceTracker.frame(nowMs),
      this.handTracker,
      nowMs,
      this.poseTracker,
      this.poseTracker.frame(nowMs),
    );
    this.simT = t;
  }

  /**
   * 按定步长积到 t，然后渲染一帧。有轨迹这类跨帧状态的模板必须走这条。
   *
   * 为什么不能直接 renderAt(t)：轨迹是「锚点走过的路」，直接跳过去等于
   * 只喂了一个点，画不出带。而且**步长必须是定的** —— 跟着真实帧率走的话
   * 同一段手势在不同机器上生成不同的轨迹，golden 不成立。
   *
   * 时间倒流（先渲染 t=P 再渲染 t=0）时从头重算：状态是历史的函数，
   * 倒着走没有意义。TrailBuffer 里也有一层同样的保护。
   */
  stepTo(t: number, step = SIM_STEP) {
    /*
     * 倒流之后必须**从 0 重积**，不能只把状态清掉。
     *
     * 这里踩过一次：resetSim() 把 simT 设成 -1，而 -1 又被下面「首次调用不补一整段」
     * 那条优化当成了首次调用 —— 于是倒流回 t 只喂了一个采样点，轨迹是空的。
     * 表现出来是「同一个 t，先渲染过更晚的时刻再回来，画面不一样」，
     * 而这正好否定了整套离线验证的前提。加轨迹探针模板时才暴露出来：
     * 它的 golden 在 t=2.0 录不出来，因为录 golden 的那次调用恰好走在倒流路径上。
     *
     * 用局部变量而不是让 resetSim 把 simT 设成 0：simT = 0 会让「首次调用」
     * 和「倒流到 0」两种状态又混在一起，是同一个 bug 换个地方长出来。
     */
    let tt: number;
    if (t < this.simT) {
      this.resetSim();
      /*
       * 显式在 t=0 推进一次，然后再让循环从 0 走。
       *
       * 少了这一下的话第一个采样点落在 1/60 而不是 0 —— 因为循环是
       * `while (tt + step < t) { tt += step; ... }`，它永远不会在起点上推进。
       * 而顺着走的路径在装载模板时已经渲染过 t=0，起点是有采样的。
       * 差一个采样点的表现极其轻微（实测 200 万个通道里差 166 个、最大差值 2），
       * 靠肉眼和带容差的差异比对都发现不了，只有逐位比对才抓得到。
       */
      this.advance(0);
      tt = 0;
    } else {
      // 首次调用时不从 0 补一整段：那会让「渲染 t=10s」变成 600 步的空转
      tt = this.simT < 0 ? t : this.simT;
    }
    /*
     * 循环停在 t **之前**，最后无条件在 t 上推进一次。
     *
     * 不这么写的话 t 和 simT 相等时一步都不推进 —— 而「同一个 t 再渲染一遍」
     * 是个真实用例：用户拖了一下交互元素，位置变了但时间没变，
     * 不推进的话画面纹丝不动。
     * 让循环别正好落在 t 上，是为了避免最后那次推进变成重复推进 ——
     * 重复喂同一个时间戳给 MediaPipe 的 VIDEO 模式会直接抛「时间戳不单调」。
     */
    while (tt + step < t) {
      tt += step;
      this.advance(tt);
    }
    this.advance(t);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 只给离线 harness 的 renderDirect 用：清干净状态，好让「直接跳到 t」
   * 从一个确定的起点出发。生产代码不该调它 —— 切模板和时间倒流已经自动清了。
   */
  resetSimForTest() {
    this.resetSim();
  }

  /** 清掉所有跨帧状态。切模板和时间倒流时都要调。 */
  private resetSim() {
    this.simT = -1;
    this.elements.resetState();
  }

  /**
   * 「追踪上了没」要问当前真正在跑的那个感知，不能一律问分割。
   * facetrack 模板根本不跑分割，field.seen 恒为 false，
   * 于是脸明明已经追上了，状态栏还写着「Looking for a person…」。
   */
  private isTracking(nowMs: number): boolean {
    // 「追踪上了没」要问当前真正在跑的那些感知，任意一个命中就算。
    // 一律问分割的老写法让 facetrack 模板永远显示「在找人」。
    const checks: boolean[] = [];
    if (this.perception.includes("face")) checks.push(this.faceTracker.frame(nowMs) !== null);
    if (this.perception.includes("hands")) checks.push(this.handTracker.frames(nowMs).length > 0);
    if (this.perception.includes("pose")) checks.push(this.poseTracker.frame(nowMs) !== null);
    if (this.perception.includes("segmentation")) checks.push(this.field.seen);
    return checks.some(Boolean);
  }

  private perceive(nowMs: number) {
    if (this.perception.includes("face")) this.faceTracker.detect(this.source, nowMs);
    if (this.perception.includes("hands")) this.handTracker.detect(this.source, nowMs);
    if (this.perception.includes("pose")) this.poseTracker.detect(this.source, nowMs);
    if (this.perception.includes("segmentation")) this.runSegmentation(nowMs);
  }

  /**
   * 把占据场传成纹理。7KB 的 Float32Array 每帧转 R8 上传，开销可忽略，
   * 不要在 GPU 侧重做平滑——ingest() 里已经做过一次了。
   */
  private updateMask() {
    if (!this.maskTex) return;

    // maskField 的尺寸第一帧才定下来，对不上就换一张纹理
    const mw = this.maskField.width;
    const mh = this.maskField.height;
    if (mw > 0 && (this.maskTex.image.width !== mw || this.maskTex.image.height !== mh)) {
      this.maskTex.dispose();
      this.maskTex = makeMaskTexture(mw, mh);
      if (this.bgUniforms?.maskTex) this.bgUniforms.maskTex.value = this.maskTex;
    }

    const data = this.maskTex.image.data as unknown as Uint8Array;
    if (this.maskField.seen) {
      const src = this.maskField.data;
      if (src && src.length === data.length) data.set(src);
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

  /** 把时间喂给帧效果。t 由调用方给，引擎自己不读挂钟 —— 见 uTime 的注释。 */
  private setEffectTime(t: number) {
    if (this.bgUniforms?.uTime) this.bgUniforms.uTime.value = t;
  }

  /**
   * 把脸部保护椭圆喂给帧效果。
   *
   * 丢脸时置 0（不保护）而不是保持上一帧：脸没了还护着一块，
   * 那块会挂在空气里跟着画面走，比不护更怪。
   */
  private setFaceProtect(nowMs: number) {
    if (!this.bgUniforms?.faceProtect || !this.bgUniforms.faceOval) return;
    const f = this.excludeFace ? this.faceTracker.frame(nowMs) : null;
    if (!f) {
      this.bgUniforms.faceProtect.value = 0;
      return;
    }
    const o = faceOval(f, this.excludePadding);
    (this.bgUniforms.faceOval.value as THREE.Vector4).set(o.cx, o.cy, o.rx, o.ry);
    this.bgUniforms.faceProtect.value = 1;
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
    /*
     * 检测除了「有新视频帧」之外，手机上还要**限速**。
     *
     * 原来只要摄像头出了新帧就跑一次检测。桌面上没问题，手机上一帧姿态检测
     * 要二三十毫秒，30fps 的摄像头等于每帧都把主线程占满 —— 渲染跟着掉，
     * 录出来的视频也跟着卡。
     *
     * 渲染仍然满帧，只是覆盖层的更新慢一点。这在观感上几乎看不出来：
     * fluidity 的 detectHz 本来就只有 14，泡泡和手部也不需要 30Hz 的位置更新。
     */
    const frameTime = this.video ? this.video.currentTime : t;
    const minGap = this.degraded ? 1 / DETECT_HZ_MOBILE : 0;
    if (frameTime !== this.lastVideoTime && t - this.lastDetectT >= minGap) {
      this.lastVideoTime = frameTime;
      this.lastDetectT = t;
      this.perceive(now);
    }

    this.updateMask();
    this.setEffectTime(t);
    this.setFaceProtect(now);

    if (this.cfg?.elements?.length) {
      this.elements.update(
        t,
        this.faceTracker,
        this.faceTracker.frame(now),
        this.handTracker,
        now,
        this.poseTracker,
        this.poseTracker.frame(now),
      );
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
      this.onStats?.({
        fps: this.fps,
        tracking: this.isTracking(now),
        degraded: this.degraded,
      camera: this.camInfo,
      zoom: this.zoom,
        needsTracking: this.perception.length > 0,
      });
    }
  };
}

/** 单通道蒙版纹理。LinearFilter 让放大到全屏时边缘是渐变而不是硬台阶。 */
function makeMaskTexture(w: number, h: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array(w * h), w, h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
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
