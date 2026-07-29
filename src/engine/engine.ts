import * as THREE from "three";
import { OccupancyField } from "./occupancy";
import { MaskField } from "./mask-field";
import {
  MediaPipeSegmentationProvider,
  type SegmentationProvider,
} from "./segmentation";
import { ParticleSystem } from "./particles";
import { ElementRenderer } from "./element-renderer";
import { FaceTracker, MediaPipeLandmarkProvider, type FrameSource, type LandmarkProvider } from "./face-tracker";
import { propCanvas } from "./props";
import { resolveControls } from "./resolve";
import { EFFECT_COMBINE, EFFECT_SNIPPETS } from "./source-effects";
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
  private templateType: TemplateType = "particle";
  private perception: string[] = ["segmentation"];
  private segProvider: SegmentationProvider | null = null;
  /** 丢人兜底策略，来自 source.mask.onLost */
  private onLost: "clear" | "hold" | "full" = "clear";
  private applyOutside = true;
  /** source.effect.blocks，短边格数。resize 时要按新比例重算长边格数 */
  private blocks = 0;
  /** source.effect.radius，归一化到长边。resize 时要按新比例重算 uv 步长 */
  private blurRadius = 0;
  /** 注入进背景材质的 uniform 引用，onBeforeCompile 时拿到 */
  private bgUniforms: Record<string, { value: unknown }> | null = null;
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
    // 有没有帧效果，背景材质都是 MeshBasicMaterial，贴图都挂在 map 上
    const mat = this.bgMat as THREE.MeshBasicMaterial;
    mat.map = this.sourceTex;
    mat.needsUpdate = true;
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
    if (!source || !EFFECT_SNIPPETS[source.effect.kind]) {
      // 恢复普通视频材质
      this.bgMat = new THREE.MeshBasicMaterial({ map: this.sourceTex });
      this.bg.material = this.bgMat;
      this.bgUniforms = null;
      this.blocks = 0;
      this.blurRadius = 0;
      this.maskTex?.dispose();
      this.maskTex = null;
      return;
    }
    this.onLost = source.mask.onLost ?? "clear";
    this.maskField.setFeather(source.mask.feather ?? 0);
    this.maskField.reset();
    // 纹理尺寸跟 maskField 走，而 maskField 的尺寸要等第一帧 mask 才知道，
    // 所以这里先给一个 1x1 占位，updateMask 里发现尺寸对不上再重建。
    this.maskTex = makeMaskTexture(1, 1);

    const effect = source.effect;
    const applyOutside = source.apply === "outside";
    this.applyOutside = applyOutside;
    this.blocks = effect.kind === "pixelate" || effect.kind === "pixel-art" ? effect.blocks : 0;
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

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform sampler2D maskTex;
          uniform vec2 blocks;
          uniform vec2 blurStep;
          uniform float amount;
          uniform float applyOutside;
          uniform float maskBias;`,
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
            return smoothstep(0.42 - maskBias, 0.58 - maskBias, texture2D(maskTex, vec2(uv.x, 1.0 - uv.y)).r);
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
   * 蒙版这一路的实时状态。排查「效果没生效」时的第一手证据。
   *
   * 「整幅画面都没效果」和「效果作用错了地方」是两类完全不同的故障：
   * 前者多半是 seen=false 走了 onLost 兜底（整张蒙版被填成「哪里都不作用」），
   * 后者才是蒙版本身的问题。光看画面区分不了，看这几个数字一眼就知道。
   */
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
    this.bg.scale.set(-bgW, bgH, 1);
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
    this.faceTracker.setViewport(this.W, this.H);
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

    // 触屏双指捏合
    let pinchStart = 0;
    let pinchTarget: ReturnType<ElementRenderer["hitTest"]> = null;
    const touchDist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    canvas.addEventListener("touchstart", (ev) => {
      if (ev.touches.length !== 2) return;
      const r = canvas.getBoundingClientRect();
      const mx = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
      const my = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
      pinchTarget = this.elements.hitTest(
        ((mx - r.left) / r.width - 0.5) * this.W,
        (0.5 - (my - r.top) / r.height) * this.H,
      );
      if (pinchTarget?.elem.interactive?.resize) pinchStart = touchDist(ev.touches);
      else pinchTarget = null;
    });
    canvas.addEventListener(
      "touchmove",
      (ev) => {
        if (!pinchTarget || ev.touches.length !== 2 || pinchStart === 0) return;
        ev.preventDefault();
        const d = touchDist(ev.touches);
        this.elements.zoomBy(pinchTarget, d / pinchStart);
        pinchStart = d;
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
