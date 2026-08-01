/**
 * 元素渲染器。overlay 和 facetrack 共用这一个——它们的差别只是 anchor.space，
 * 没有理由维护两份几乎一样的代码。
 *
 * 每个元素是一张贴了纹理的 plane。定位分三步：
 *   1. anchor 决定中心在哪（屏幕归一化坐标 / 人脸 landmark + IOD 偏移）
 *   2. size 决定多大（参照物 × 倍数，参照物与 anchor.space 正交）
 *   3. animations 在上面叠位移 / 缩放 / 透明度 / 旋转
 */

import * as THREE from "three";
import type { ElementAsset, ElementBlend, ElementV2, SizeRef } from "./types";
import { getSvg, getSvgAspect, rasterizeSvg, rasterizeText } from "./svg-assets";
import { ensureTextFont } from "./text-font";
import { extractAspect } from "./svg-sanitize";
import { evaluateAnimations } from "./animations";
import { PinchDetector, TRAIL_RATE, TrailBuffer } from "./trail";
import { BubbleField } from "./bubbles";
import { FINGER_TIPS } from "./hand-anchors";
import type { FaceFrame, FaceTracker } from "./face-tracker";
import type { HandFrame, HandTracker } from "./hand-tracker";

/** 确定性 hash。叶子的位置和大小都走它，不许出现真随机数 */
function hash1(i: number, seed: number): number {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** 文字统一按这个字号栅格化一次，再按 size 缩放 mesh。避免人一动就重新栅格化。 */
const TEXT_RASTER_PX = 64;

/** 捏合绽放额外带的东西：边沿检测器 + 一池花的网格 */
interface BloomParts {
  detector: PinchDetector;
  sprites: THREE.Mesh[];
}

/**
 * 一条带 + 沿途叶子。轨迹（trail）和茎（stem）共用。
 *
 * 两者的差别只在**点从哪来**：轨迹从历史缓冲里来，茎从「底边到指尖的曲线」算出来。
 * 建带、写顶点、摆叶子这三件事完全一样，所以共用一套结构，别复制两份。
 */
interface RibbonParts {
  /** 只有轨迹有。茎是当前帧的纯函数，不需要历史 */
  buffer?: TrailBuffer;
  ribbon: THREE.Mesh;
  ribbonGeo: THREE.BufferGeometry;
  /** 顶点缓冲。容量在建的时候定死，运行时不再分配 */
  positions: Float32Array;
  alphas: Float32Array;
  leaves: THREE.Mesh[];
  /** 只有茎有：长在生长那一头的花 */
  flower?: THREE.Mesh;
}

interface Item {
  mesh: THREE.Mesh;
  elem: ElementV2;
  /** 纹理的高/宽 */
  aspect: number;
  /** 文字：mesh 宽度 = 纹理像素宽 × (字号 / TEXT_RASTER_PX) */
  textPxWidth: number;
  /** 用户拖出来的位移，px。只对 interactive.drag 的元素有效 */
  userDx: number;
  userDy: number;
  /** 用户滚轮缩放的倍率 */
  userScale: number;
  /** 上一帧算出来的屏幕尺寸，命中测试用 */
  lastW: number;
  lastH: number;
  /**
   * 这个元素创建的**所有** Object3D，clear() 按它拆干净。
   *
   * 不这么记的话，只有 item.mesh 会被移除 —— trail 的叶子池和 pinch-bloom 的花池
   * 是单独 add 到 group 里的，切模板之后会永久留在画面上。
   * 这个 bug 我犯过一次：从「指尖开花」切到别的模板，叶子还挂在脸上。
   */
  owned: THREE.Object3D[];
  trail?: RibbonParts;
  bloom?: BloomParts;
  bubbles?: BubbleField;
}

export class ElementRenderer {
  private readonly group = new THREE.Group();
  private readonly items: Item[] = [];
  private W = 1280;
  private H = 720;
  private generation = 0;
  /** 最近一次 setElements 的完成信号。离线 harness 必须等纹理栅格化完才能截图。 */
  private pending: Promise<void> = Promise.resolve();
  /** 这一批里解不出素材、被跳过的元素。见 build() 里的注释 */
  private readonly missingAssets: string[] = [];
  /**
   * 当前画面源的纹理。泡泡的折射要采它 —— 泡泡背后就是摄像头画面，
   * 而那正是想要的效果，不需要读回帧缓冲。
   */
  private sourceTex: THREE.Texture | null = null;

  constructor(scene: THREE.Scene) {
    this.group.renderOrder = 5;
    scene.add(this.group);
  }

  setViewport(w: number, h: number) {
    this.W = w;
    this.H = h;
    for (const it of this.items) it.bubbles?.setViewport(w, h);
  }

  /** 引擎换源（摄像头 ↔ 离线静态图）时要重新传，否则泡泡里是上一张画面 */
  setSourceTexture(tex: THREE.Texture | null) {
    this.sourceTex = tex;
    for (const it of this.items) it.bubbles?.setSource(tex);
  }

  setElements(elements: ElementV2[]): Promise<void> {
    this.pending = this.build(elements);
    return this.pending;
  }

  /** 所有元素的纹理都就绪。 */
  ready(): Promise<void> {
    return this.pending;
  }

  private async build(elements: ElementV2[]): Promise<void> {
    this.clear();
    const gen = this.generation;

    // 有文字元素就先把内嵌字体等到位。不等的话第一次栅格化会落到系统字体上，
    // 同一份 JSON 在不同机器上字形不同 —— golden 就只在录它的那台机器上成立。
    if (elements.some((e) => e.asset.kind === "text")) await ensureTextFont();
    if (gen !== this.generation) return;

    for (const elem of elements) {
      if (gen !== this.generation) return; // 已切模板，放弃这批

      if (elem.asset.kind === "trail" || elem.asset.kind === "stem") {
        const parts =
          elem.asset.kind === "trail" ? await this.buildTrail(elem, elem.asset) : await this.buildStem(elem.asset);
        if (gen !== this.generation) return;
        if (parts) {
          this.items.push({
            mesh: parts.ribbon,
            elem,
            aspect: 1,
            textPxWidth: 0,
            userDx: 0,
            userDy: 0,
            userScale: 1,
            lastW: 0,
            lastH: 0,
            owned: [parts.ribbon, ...parts.leaves, ...(parts.flower ? [parts.flower] : [])],
            trail: parts,
          });
        }
        continue;
      }

      if (elem.asset.kind === "bubbles") {
        const a = elem.asset;
        /*
         * 池子容量给到 count 的两倍再加余量：破掉的泡泡还要占位跑完残留动画，
         * 而这期间新的已经在冒了。给死 count 的话满屏时戳破会看到「补不上」。
         */
        const field = new BubbleField(
          {
            count: a.count,
            rise: a.rise,
            size: a.size,
            wobble: a.wobble,
            popRadius: a.popRadius,
            refraction: a.refraction,
            iridescence: a.iridescence,
            opacity: elem.opacity ?? 1,
            seed: a.seed,
          },
          Math.min(256, a.count * 2 + 8),
        );
        field.setViewport(this.W, this.H);
        field.setSource(this.sourceTex);
        this.group.add(field.mesh);
        this.items.push({
          mesh: field.mesh,
          elem,
          aspect: 1,
          textPxWidth: 0,
          userDx: 0,
          userDy: 0,
          userScale: 1,
          lastW: 0,
          lastH: 0,
          owned: [field.mesh],
          bubbles: field,
        });
        continue;
      }

      if (elem.asset.kind === "pinch-bloom") {
        const parts = await this.buildBloom(elem.asset);
        if (gen !== this.generation) return;
        if (parts) {
          this.items.push({
            mesh: parts.sprites[0],
            elem,
            aspect: 1,
            textPxWidth: 0,
            userDx: 0,
            userDy: 0,
            userScale: 1,
            lastW: 0,
            lastH: 0,
            owned: [...parts.sprites],
            bloom: parts,
          });
        }
        continue;
      }

      const built = await this.buildTexture(elem);
      if (gen !== this.generation) return;
      if (!built) {
        /*
         * 素材解不出来时**记下来**，不要静默跳过。
         *
         * 这条路真的踩过：新素材加进 SVG_LIB 之后 dev server 拿的是旧 bundle，
         * getSvg() 返回 undefined，元素被无声跳过 —— 画面上只剩文字元素，
         * 而校验、回归、冒烟全是绿的（冒烟只验了「画面不是纯色」）。
         * 现在 debugStats().missingAssets 会报出来，smoke:live 据此判失败。
         */
        const a = elem.asset as { kind: string; key?: string };
        this.missingAssets.push(`${elem.id}: ${a.kind}${a.key ? ` "${a.key}"` : ""}`);
        continue;
      }

      const mat = new THREE.MeshBasicMaterial({
        map: built.tex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      });
      applyBlend(mat, elem.blend);
      built.tex.colorSpace = THREE.SRGBColorSpace;

      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.renderOrder = 5;
      this.items.push({
        mesh,
        elem,
        aspect: built.aspect,
        textPxWidth: built.textPxWidth,
        userDx: 0,
        userDy: 0,
        userScale: 1,
        lastW: 0,
        lastH: 0,
        owned: [mesh],
      });
      this.group.add(mesh);
    }
  }

  /**
   * 轨迹元素：一条带 + 一池叶子。
   *
   * 顶点缓冲按 seconds × TRAIL_RATE 预留满，运行时只改内容不重新分配 ——
   * 每帧 new 一个 BufferGeometry 会让 GC 在录制时抖。
   */
  private async buildTrail(
    elem: ElementV2,
    asset: Extract<ElementAsset, { kind: "trail" }>,
  ): Promise<RibbonParts | null> {
    const maxPts = Math.max(2, Math.ceil(asset.seconds * TRAIL_RATE) + 2);
    const parts = this.buildRibbonMesh(maxPts, asset.color);
    // 叶子池容量按「带最长时能放几片」算，够不到的隐藏
    parts.leaves = asset.leaf ? await this.buildLeafPool(asset.leaf.key, Math.max(1, Math.ceil(asset.seconds * 4))) : [];
    parts.buffer = new TrailBuffer(asset.seconds);
    void elem;
    return parts;
  }

  /**
   * 茎：一条带 + 一池叶子 + 顶端一朵花。
   *
   * 顶点数是固定的（segments），因为茎的点不是采样出来的历史，而是每帧从
   * 「底边 → 指尖」这条曲线上重新算的。长度变化靠改 drawRange，不改顶点数。
   */
  private async buildStem(asset: Extract<ElementAsset, { kind: "stem" }>): Promise<RibbonParts | null> {
    const segs = Math.max(4, Math.min(64, asset.segments ?? 24));
    const parts = this.buildRibbonMesh(segs, asset.color);

    if (asset.leaf) {
      /*
       * 池子按「茎最长时能放几片」算，而不是按 segments。
       *
       * 茎满长时的弧长最多约一个画面高度，而 spacing 的单位是 size.ref（掌宽）。
       * 画面高 / 掌宽 在正常取景下大约 3~4，所以 ceil(4 / spacing) 是上界，
       * 再加 2 片余量。算多了只是几个隐藏的 mesh，算少了叶子会在中途断掉。
       */
      const count = Math.max(1, Math.min(40, Math.ceil(4 / Math.max(0.05, asset.leaf.spacing)) + 2));
      parts.leaves = await this.buildLeafPool(asset.leaf.key, count);
    } else {
      parts.leaves = [];
    }

    if (asset.flower) {
      const [flower] = await this.buildLeafPool(asset.flower.key, 1);
      if (flower) {
        flower.renderOrder = 5; // 花压在茎和叶子之上
        parts.flower = flower;
      }
    }
    return parts;
  }

  /** 带的几何 + 材质。顶点缓冲在这里一次分配满，运行时只改内容。 */
  private buildRibbonMesh(maxPts: number, colorHex: string): RibbonParts {
    // 每个点两个顶点（带的两侧），三角带用索引连
    const positions = new Float32Array(maxPts * 2 * 3);
    const alphas = new Float32Array(maxPts * 2);
    const index: number[] = [];
    for (let i = 0; i < maxPts - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));
    geo.setIndex(index);

    const color = new THREE.Color(colorHex);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: color } },
      vertexShader: `
        attribute float aAlpha;
        varying float vA;
        void main(){
          vA = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor; varying float vA;
        void main(){
          if (vA < 0.004) discard;
          gl_FragColor = vec4(uColor, vA);
        }`,
    });

    const ribbon = new THREE.Mesh(geo, mat);
    ribbon.frustumCulled = false;
    ribbon.renderOrder = 4; // 压在背景之上、贴纸之下：茎要被指尖的花盖住
    this.group.add(ribbon);

    return { ribbon, ribbonGeo: geo, positions, alphas, leaves: [] };
  }

  /**
   * 一池共用同一张贴图的 sprite。
   *
   * 贴图**只栅格化一次**给整池共用，所以 clear() 里 dispose 贴图必须去重 ——
   * 对同一张 Texture 调两次 dispose 会炸。
   */
  private async buildLeafPool(key: string, count: number): Promise<THREE.Mesh[]> {
    const svg = getSvg(key);
    if (!svg) return [];
    const aspect = getSvgAspect(key);
    const canvas = await rasterizeSvg(svg, 128, Math.max(1, Math.round(128 * aspect)));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const out: THREE.Mesh[] = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
      );
      m.renderOrder = 4;
      m.visible = false;
      this.group.add(m);
      out.push(m);
    }
    return out;
  }

  /**
   * 轨迹的一帧：采样 → 重建带 → 摆叶子。
   *
   * 采样点存的是**归一化坐标**而不是世界坐标：视口会变（resize、手机转屏），
   * 存世界坐标的话转一下屏整条带就错位了。
   */
  private updateTrail(
    item: Item,
    elem: ElementV2,
    t: number,
    basePx: number,
    face: FaceFrame | null,
    hand: HandFrame | null,
    tracker: FaceTracker,
    handTracker?: HandTracker,
  ) {
    const parts = item.trail!;
    const asset = elem.asset as Extract<ElementAsset, { kind: "trail" }>;

    // 锚点当前在哪（归一化，y 向下）
    let np: { x: number; y: number } | null = null;
    if (elem.anchor.space === "hand" && hand && handTracker) {
      np = handTracker.landmarkAt(hand, elem.anchor.landmark);
    } else if (elem.anchor.space === "face" && face) {
      np = tracker.landmarkAt(face, elem.anchor.landmark);
    }
    if (np) parts.buffer!.sample(t, np.x, np.y);

    const pts = parts.buffer!.points();
    if (pts.length < 2) {
      this.hideRibbon(parts);
      return;
    }

    // 归一化 → 世界。和背景平面、人脸、手部守同一个镜像约定：0.5 - x
    const pw = pts.map((p) => ({ x: (0.5 - p.x) * this.W, y: (0.5 - p.y) * this.H }));
    // 越老越淡。年龄按**时间**算而不是按下标：低帧率下点少，按下标算会让淡出速度变快
    const newest = pts[pts.length - 1].t;
    const alpha = pts.map(
      (p) => Math.max(0, 1 - (newest - p.t) / Math.max(1e-4, asset.seconds)) * (elem.opacity ?? 1),
    );

    this.writeRibbon(parts, pw, (basePx * elem.size.scale) / 2, alpha);
    // 从最新的一端往老的方向摆叶子：新长出来的位置稳定，
    // 不会因为尾巴被裁掉而整排跳一格
    this.placeLeaves(parts, asset.leaf, basePx, pw, alpha, false);
  }

  /**
   * 茎的一帧：按弯曲度截取「底边 → 指尖」这条曲线。
   *
   * **整个函数是当前帧的纯函数**，没有任何跨帧状态。这是它和 trail 的根本区别：
   * 同一份 landmarks 渲染多少次都是同一张图，renderAt(t) 可以直接跳到任意 t。
   */
  private updateStem(item: Item, elem: ElementV2, basePx: number, hand: HandFrame | null, handTracker?: HandTracker) {
    const parts = item.trail!;
    const asset = elem.asset as Extract<ElementAsset, { kind: "stem" }>;

    const tip =
      elem.anchor.space === "hand" && hand && handTracker
        ? handTracker.landmarkAt(hand, elem.anchor.landmark)
        : null;
    const curl = hand ? (hand.curl[asset.finger] ?? 0) : 0;
    /*
     * 阈值以下整根不画。
     *
     * 不设的话手伸直时读到的 0.02~0.05 会在指尖下面留一小截「毛刺」——
     * 十根手指同时有，看起来像画面坏了。0.06 刚好在伸直的噪声之上
     * （fixture 上伸开的手读 0.00~0.01）。
     */
    if (!tip || curl < 0.06) {
      this.hideRibbon(parts);
      return;
    }

    const segs = Math.max(4, Math.min(64, asset.segments ?? 24));
    const tx = (0.5 - tip.x) * this.W;
    const ty = (0.5 - tip.y) * this.H;
    const baseY = -this.H / 2; // 画面底边
    /*
     * 弯的方向由 seed 定，不由手的左右定。
     *
     * 按左右手分的话两边会镜像般地一起倒，读起来像装饰边框；
     * 按 seed 分则每根茎各有各的倒向，更像一片长出来的植物。
     */
    const dir = hash1(asset.seed, 7) > 0.5 ? 1 : -1;
    const bow = (asset.bow ?? 0.06) * this.W * dir;

    // 二次贝塞尔：底边起点 → 控制点（横向偏 bow）→ 指尖。s=0 在底边，s=1 在指尖
    const p0x = tx - bow * 0.35;
    const pw: { x: number; y: number }[] = [];
    for (let i = 0; i < segs; i++) {
      const u = i / (segs - 1);
      // 只画前 curl 段：长度直接跟着手指弯曲度走
      const s = u * curl;
      const mx = (1 - s) * (1 - s) * p0x + 2 * (1 - s) * s * (p0x + bow) + s * s * tx;
      const my = (1 - s) * (1 - s) * baseY + 2 * (1 - s) * s * ((baseY + ty) / 2) + s * s * ty;
      pw.push({ x: mx, y: my });
    }

    /*
     * 顶端两个点收细，底部不收。
     *
     * 等宽的茎末端是个平口，像根管子；顶端收尖才像植物。
     * 底部不收是因为它被画面边缘切掉了，收了反而露出一个尖角。
     */
    const alpha = pw.map(() => elem.opacity ?? 1);
    this.writeRibbon(parts, pw, (basePx * elem.size.scale) / 2, alpha, (i) => (i >= segs - 2 ? 0.45 : 1));
    // 从底边往上摆叶子（fromStart）：茎在长的时候，已经摆好的叶子不该跟着挪
    this.placeLeaves(parts, asset.leaf, basePx, pw, alpha, true);

    if (parts.flower && asset.flower) {
      const tipPt = pw[pw.length - 1];
      const s = asset.flower.scale * basePx;
      parts.flower.visible = true;
      parts.flower.position.set(tipPt.x, tipPt.y, 6);
      parts.flower.scale.set(s, s, 1);
      // 花跟着茎尖的切向立起来，不然满长时会歪在一边
      const prev = pw[Math.max(0, pw.length - 3)];
      parts.flower.rotation.z = Math.atan2(tipPt.y - prev.y, tipPt.x - prev.x) - Math.PI / 2;
      (parts.flower.material as THREE.MeshBasicMaterial).opacity = elem.opacity ?? 1;
    }
  }

  private hideRibbon(parts: RibbonParts) {
    parts.ribbon.visible = false;
    for (const l of parts.leaves) l.visible = false;
    if (parts.flower) parts.flower.visible = false;
  }

  /**
   * 把一串世界坐标点写成一条带。轨迹和茎共用。
   *
   * taper 给每个点一个宽度倍率（茎用它把顶端收尖），不给就是等宽。
   */
  private writeRibbon(
    parts: RibbonParts,
    pw: readonly { x: number; y: number }[],
    halfW: number,
    alpha: readonly number[],
    taper?: (i: number) => number,
  ) {
    parts.ribbon.visible = true;
    const { positions, alphas } = parts;

    for (let i = 0; i < pw.length; i++) {
      // 切向用中心差分，端点退化成单侧 —— 只看后一个点的话末端会突然歪
      const prev = pw[Math.max(0, i - 1)];
      const next = pw[Math.min(pw.length - 1, i + 1)];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) {
        dx = 0;
        dy = 1;
      } else {
        dx /= len;
        dy /= len;
      }
      // 法向 = 切向转 90°
      const hw = halfW * (taper ? taper(i) : 1);
      const px = -dy * hw;
      const py = dx * hw;
      const o = i * 6;
      positions[o] = pw[i].x + px;
      positions[o + 1] = pw[i].y + py;
      positions[o + 2] = 4;
      positions[o + 3] = pw[i].x - px;
      positions[o + 4] = pw[i].y - py;
      positions[o + 5] = 4;

      alphas[i * 2] = alpha[i];
      alphas[i * 2 + 1] = alpha[i];
    }

    // 没用到的顶点塌到最后一个点上并置 0 透明度 —— 留着旧数据会拖出一条尾巴
    const last = (pw.length - 1) * 6;
    for (let i = pw.length; i * 6 + 5 < positions.length; i++) {
      const o = i * 6;
      for (let k = 0; k < 6; k++) positions[o + k] = positions[last + k];
      alphas[i * 2] = 0;
      alphas[i * 2 + 1] = 0;
    }

    parts.ribbonGeo.attributes.position.needsUpdate = true;
    parts.ribbonGeo.attributes.aAlpha.needsUpdate = true;
    parts.ribbonGeo.setDrawRange(0, Math.max(0, (pw.length - 1) * 6));
  }

  /**
   * 沿带的弧长摆叶子。
   *
   * 位置完全由 hash(第几片, seed) 和弧长决定 —— **不占额外状态**。
   * 每片叶子存「什么时候长出来的」会把纯函数的简单性搞没，而且没必要：
   * 弧长本身就是单调的，用它当「第几片」的坐标即可。
   *
   * fromStart 决定从哪一头开始数：轨迹从最新的一端往回（新叶子位置稳定），
   * 茎从底边往上（茎在长的时候，已经摆好的叶子不该跟着挪）。
   */
  private placeLeaves(
    parts: RibbonParts,
    leaf: { key: string; spacing: number; scale: number; seed: number } | undefined,
    basePx: number,
    pw: readonly { x: number; y: number }[],
    alpha: readonly number[],
    fromStart: boolean,
  ) {
    if (!leaf || !parts.leaves.length) return;

    const spacingPx = leaf.spacing * basePx;
    const sizePx = leaf.scale * basePx;
    let acc = 0;
    let leafIdx = 0;
    const n = pw.length;
    for (let k = 0; k < n - 1 && leafIdx < parts.leaves.length; k++) {
      // fromStart：0→n-1 顺着走；否则从末端往回走
      const ai = fromStart ? k : n - 1 - k;
      const bi = fromStart ? k + 1 : n - 2 - k;
      const a = pw[ai];
      const b = pw[bi];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (seg < 1e-4) continue;
      let need = spacingPx * (leafIdx + 1) - acc;
      while (need <= seg && leafIdx < parts.leaves.length) {
        const m = parts.leaves[leafIdx];
        const h = hash1(leafIdx, leaf.seed);
        // 左右交替但不严格轮换：严格轮换看起来像装饰花边，不像长出来的
        const side = h > 0.5 ? 1 : -1;
        const dirX = (b.x - a.x) / seg;
        const dirY = (b.y - a.y) / seg;
        const nx = -dirY * side;
        const ny = dirX * side;
        const off = sizePx * 0.42;
        m.visible = true;
        m.position.set(a.x + dirX * need + nx * off, a.y + dirY * need + ny * off, 5);
        const s = sizePx * (0.75 + hash1(leafIdx + 31, leaf.seed) * 0.5);
        m.scale.set(s * side, s, 1);
        m.rotation.z = Math.atan2(dirY, dirX) + (side > 0 ? -0.6 : 0.6);
        (m.material as THREE.MeshBasicMaterial).opacity = alpha[ai];
        leafIdx++;
        need = spacingPx * (leafIdx + 1) - acc;
      }
      acc += seg;
    }
    for (let i = leafIdx; i < parts.leaves.length; i++) parts.leaves[i].visible = false;
  }

  /** 捏合绽放：一池固定数量的花，按事件数显示。 */
  private async buildBloom(
    asset: Extract<ElementAsset, { kind: "pinch-bloom" }>,
  ): Promise<BloomParts | null> {
    const svg = getSvg(asset.key);
    if (!svg) return null;
    const aspect = getSvgAspect(asset.key);
    const canvas = await rasterizeSvg(svg, 192, Math.max(1, Math.round(192 * aspect)));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;

    // 池子大小 = 缓冲能存的事件数。多了浪费，少了会让快速连捏时新的顶掉旧的
    const sprites: THREE.Mesh[] = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, aspect),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
      );
      m.renderOrder = 6; // 压在花和茎之上：刚捏出来的那朵该是最显眼的
      m.visible = false;
      this.group.add(m);
      sprites.push(m);
    }
    return { detector: new PinchDetector(asset.seconds), sprites };
  }

  /**
   * 捏合的一帧：喂比值给边沿检测器，再把活着的事件画出来。
   *
   * 位置用拇指尖和食指尖的**中点**，不用某一个 landmark ——
   * 捏合的语义是「两指相碰的那个点」，用单指会让花偏在一侧。
   */
  private updateBloom(item: Item, elem: ElementV2, t: number, basePx: number, hand: HandFrame, handTracker: HandTracker) {
    const parts = item.bloom!;
    const asset = elem.asset as Extract<ElementAsset, { kind: "pinch-bloom" }>;
    const thumb = handTracker.landmarkAt(hand, "thumb_tip");
    const index = handTracker.landmarkAt(hand, "index_tip");
    if (thumb && index) {
      const mx = (thumb.x + index.x) / 2;
      const my = (thumb.y + index.y) / 2;
      // 距离要除以掌宽换算成「相对手的大小」，否则人退远之后永远判成捏合
      const distPx = Math.hypot((thumb.x - index.x) * this.W, (thumb.y - index.y) * this.H);
      parts.detector.update(t, distPx / Math.max(1e-3, hand.palmWidth), mx, my);
    }

    const live = parts.detector.live();
    for (let i = 0; i < parts.sprites.length; i++) {
      const m = parts.sprites[i];
      const ev = live[i];
      if (!ev) {
        m.visible = false;
        continue;
      }
      const p = Math.min(1, Math.max(0, (t - ev.t) / asset.seconds));
      m.visible = true;
      // 前 25% 弹出、之后边长大边淡出。一上来就全尺寸会显得没有「绽开」的动作
      const pop = p < 0.25 ? p / 0.25 : 1;
      const s = basePx * asset.grow * (0.35 + 0.65 * pop) * (1 + p * 0.45);
      m.scale.set(s, s, 1);
      m.position.set((0.5 - ev.x) * this.W, (0.5 - ev.y) * this.H, 6);
      (m.material as THREE.MeshBasicMaterial).opacity = 1 - p * p;
    }
  }

  /** 解不出素材而被跳过的元素。空数组 = 全都画上了。 */
  missing(): readonly string[] {
    return this.missingAssets;
  }

  /** 元素总数，用来判断「装上了几个」。 */
  count(): number {
    return this.items.length;
  }

  /**
   * 元素组里实际的 Object3D 数量。
   *
   * 一个元素可能拥有多个 mesh，所以这个数和 count() 不是一回事。
   * 切模板后它没回落就说明有 mesh 没被拆掉 —— 而泄漏的那些当时可能刚好隐藏着，
   * 只看画面是抓不到的。
   */
  objectCount(): number {
    return this.group.children.length;
  }

  /**
   * 当前还活着的泡泡数。测试靠它断言「真的在冒」和「指尖真的戳破了」——
   * 戳破是这个模拟里唯一可变的状态，只看画面很难把它和「飘走了」区分开。
   */
  bubbleAlive(): number {
    let n = 0;
    for (const it of this.items) n += it.bubbles?.aliveCount() ?? 0;
    return n;
  }

  /** 清掉所有跨帧状态。切模板和时间倒流时调 —— 见 engine.stepTo。 */
  resetState() {
    for (const it of this.items) {
      // 茎没有 buffer：它是当前帧的纯函数，没有要清的状态
      it.trail?.buffer?.clear();
      it.bubbles?.reset();
      it.bloom?.detector.clear();
    }
  }

  /** 四种 asset.kind 各自的栅格化路径。返回 null 表示这个元素画不出来，跳过。 */
  private async buildTexture(
    elem: ElementV2,
  ): Promise<{ tex: THREE.Texture; aspect: number; textPxWidth: number } | null> {
    const a = elem.asset;

    if (a.kind === "svg-lib" || a.kind === "svg-inline") {
      const svgStr = a.kind === "svg-lib" ? getSvg(a.key) : a.svg;
      if (!svgStr) return null;
      const aspect = a.kind === "svg-lib" ? getSvgAspect(a.key) : extractAspect(a.svg);
      const pw = 256;
      const ph = Math.max(1, Math.round(pw * aspect));
      const canvas = await rasterizeSvg(svgStr, pw, ph);
      return { tex: new THREE.CanvasTexture(canvas), aspect, textPxWidth: 0 };
    }

    if (a.kind === "text") {
      const canvas = rasterizeText(
        a.text,
        TEXT_RASTER_PX,
        a.color ?? "#FFFFFF",
        a.fontWeight ?? 600,
        a.shadow,
      );
      return {
        tex: new THREE.CanvasTexture(canvas),
        aspect: canvas.height / canvas.width,
        textPxWidth: canvas.width,
      };
    }

    // trail / pinch-bloom 有自己的构建路径，走不到这里
    if (a.kind !== "gradient") return null;

    // gradient：程序化径向渐变椭圆。腮红这类不值得单独做成素材文件的东西。
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    const grd = ctx.createRadialGradient(64, 32, 0, 64, 32, 60);
    grd.addColorStop(0, a.color);
    grd.addColorStop(1, transparentize(a.color));
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 128, 64);
    const tex = new THREE.CanvasTexture(c);
    return { tex, aspect: 0.5, textPxWidth: 0 };
  }

  /**
   * size.ref → 像素基准。参照物解不出来时返回 null，让元素隐藏 ——
   * 没有人脸时 iod 不可解，没有手时 palm_width 不可解。
   */
  private refPixels(ref: SizeRef, face: FaceFrame | null, hand: HandFrame | null): number | null {
    switch (ref) {
      case "vw":
        return this.W;
      case "iod":
        return face ? face.iod : null;
      case "eye_width":
        return face ? face.eyeWidth : null;
      case "face_width":
        return face ? face.faceWidth : null;
      case "palm_width":
        return hand ? hand.palmWidth : null;
    }
  }

  update(
    t: number,
    tracker: FaceTracker,
    face: FaceFrame | null,
    handTracker?: HandTracker,
    nowMs = t * 1000,
  ) {
    for (const item of this.items) {
      const { mesh, elem, aspect, textPxWidth } = item;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const isFace = elem.anchor.space === "face";
      const isHand = elem.anchor.space === "hand";

      // 这只元素绑的那只手。手部空间才去查，省掉不必要的遍历
      const hand =
        isHand && handTracker ? handTracker.frame(nowMs, (elem.anchor as { hand: "left" | "right" }).hand) : null;

      // 人脸 / 手部空间的元素在目标丢失时藏起来；屏幕空间的照常显示。
      // 按 space 判断而不是按 ref：face 空间的元素用 vw 尺寸时依然需要人脸来定位。
      if ((isFace && !face) || (isHand && !hand)) {
        mesh.visible = false;
        continue;
      }

      const basePx = this.refPixels(elem.size.ref, face, hand);
      if (basePx === null) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;

      if (item.bubbles) {
        /*
         * 十根指尖全都能戳破，两只手都算。
         *
         * 只认食指的话玩起来很别扭 —— 参考素材里用户就是整只手划过去的。
         * 没有手时传空数组：泡泡照常飘，只是没人戳。
         */
        const tips: { x: number; y: number }[] = [];
        if (handTracker) {
          for (const hf of handTracker.frames(nowMs)) {
            for (const name of FINGER_TIPS) {
              const lm = handTracker.landmarkAt(hf, name);
              // 和背景平面、人脸守同一个镜像约定：0.5 - x
              if (lm) tips.push({ x: (0.5 - lm.x) * this.W, y: (0.5 - lm.y) * this.H });
            }
          }
        }
        item.bubbles.update(t, tips);
        mesh.visible = true;
        continue;
      }

      if (item.trail) {
        if (elem.asset.kind === "stem") this.updateStem(item, elem, basePx, hand, handTracker);
        else this.updateTrail(item, elem, t, basePx, face, hand, tracker, handTracker);
        continue;
      }

      if (item.bloom) {
        if (hand && handTracker) this.updateBloom(item, elem, t, basePx, hand, handTracker);
        else for (const m of item.bloom.sprites) m.visible = false;
        continue;
      }

      const base = basePx * elem.size.scale * item.userScale;
      // emit-fall-fade 的 distance 以 IOD 计（face）、掌宽计（hand）或屏幕宽度计（screen）
      const unit = isFace && face ? face.iod : isHand && hand ? hand.palmWidth : this.W;
      const anim = evaluateAnimations(elem.animations, t, this.H, unit);

      // --- 中心位置 ---
      let cx: number;
      let cy: number;
      let roll = 0;

      if (elem.anchor.space === "screen") {
        cx = (elem.anchor.nx - 0.5) * this.W;
        cy = (0.5 - elem.anchor.ny) * this.H;
      } else if (elem.anchor.space === "hand") {
        const lm = handTracker!.landmarkAt(hand!, elem.anchor.landmark);
        if (!lm) {
          mesh.visible = false;
          continue;
        }
        // 和人脸、背景平面守同一个镜像约定：0.5 - x，不是 x - 0.5
        cx = (0.5 - lm.x) * this.W;
        cy = (0.5 - lm.y) * this.H;
        // 手部元素默认**不**跟手转：emoji 立着好看，而且手的 roll 抖动比头大得多。
        // 要跟就显式写 followRoll: true
        roll = elem.followRoll ? hand!.roll : 0;

        const [ox, oy] = elem.anchor.offset ?? [0, 0];
        // 偏移以掌宽为单位。跟脸那边以 IOD 为单位是一个道理：
        // 用像素的话人一退远偏移就不成比例了
        cx += ox * hand!.palmWidth;
        cy += -oy * hand!.palmWidth + anim.positionY;
        cx += anim.outwardX;
      } else {
        const lm = tracker.landmarkAt(face!, elem.anchor.landmark);
        if (!lm) {
          mesh.visible = false;
          continue;
        }
        // 0.5 - x 而不是 x - 0.5：背景平面是 scale.x = -1 的镜像，元素必须守同一个约定
        cx = (0.5 - lm.x) * this.W;
        cy = (0.5 - lm.y) * this.H;
        roll = face!.roll;

        const [ox, oy] = elem.anchor.offset ?? [0, 0];
        const mir = elem.anchor.mirror ? -1 : 1;
        // 偏移和动画位移都以 IOD 为单位，且要跟着头一起转
        const offX = ox * face!.iod + anim.outwardX * mir;
        const offY = -oy * face!.iod + anim.positionY;
        const cos = Math.cos(-roll);
        const sin = Math.sin(-roll);
        cx += offX * cos - offY * sin;
        cy += offX * sin + offY * cos;
      }

      if (elem.anchor.space === "screen") {
        cy += anim.positionY;
        cx += anim.outwardX;
        cx += item.userDx;
        cy += item.userDy;
      }
      // fall 走整屏高度，覆盖锚点算出来的 y
      if (anim.positionYAbsolute !== null) cy = anim.positionYAbsolute;

      // --- 尺寸 ---
      // fit 决定 base 量的是宽度还是字号。svg / gradient 只有宽度一种含义，
      // 写了 fit:"font" 也当宽度处理。
      const fit = elem.size.fit ?? (elem.asset.kind === "text" ? "font" : "width");
      const w =
        elem.asset.kind === "text" && fit === "font" ? textPxWidth * (base / TEXT_RASTER_PX) : base;
      const h = w * aspect;
      const mir = elem.anchor.space === "face" && elem.anchor.mirror ? -1 : 1;

      item.lastW = Math.abs(w * anim.scaleX);
      item.lastH = Math.abs(h * anim.scaleY);
      mesh.scale.set(w * anim.scaleX * mir, h * anim.scaleY, 1);
      mesh.position.set(cx, cy, 3);
      mat.opacity = anim.opacity * (elem.opacity ?? 1);

      // --- 旋转 ---
      const selfRot = ((elem.rotation ?? 0) * -Math.PI) / 180;
      // face 空间默认跟头转；hand 空间默认**不**跟手转（见上面的注释）；screen 恒不转
      const followRoll = elem.followRoll ?? elem.anchor.space === "face";
      mesh.rotation.z = selfRot + anim.rotation - (followRoll ? roll : 0);
    }
  }

  /**
   * 世界坐标命中测试，只认 interactive 的元素。倒序遍历——
   * 后加的元素画在上面，理应先被点到。
   */
  hitTest(wx: number, wy: number): Item | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (!it.mesh.visible || !it.elem.interactive) continue;
      const { x, y } = it.mesh.position;
      if (Math.abs(wx - x) <= it.lastW / 2 && Math.abs(wy - y) <= it.lastH / 2) return it;
    }
    return null;
  }

  /** 拖动。非 drag 的元素直接忽略，调用方不用判断。 */
  moveBy(item: Item, dx: number, dy: number) {
    if (!item.elem.interactive?.drag) return;
    item.userDx += dx;
    item.userDy += dy;
  }

  /** 滚轮缩放。夹在 0.25~4 倍，免得滚过头缩没了或者铺满屏幕找不回来。 */
  zoomBy(item: Item, factor: number) {
    if (!item.elem.interactive?.resize) return;
    item.userScale = Math.min(4, Math.max(0.25, item.userScale * factor));
  }

  clear() {
    this.generation++;
    // 贴图在池化的 mesh 之间是共享的（一池叶子共用一张），用 Set 去重避免二次 dispose
    const maps = new Set<THREE.Texture>();
    for (const item of this.items) {
      for (const obj of item.owned) {
        const m = obj as THREE.Mesh;
        const mat = m.material as THREE.MeshBasicMaterial | undefined;
        if (mat?.map) maps.add(mat.map);
        mat?.dispose();
        m.geometry?.dispose();
        this.group.remove(obj);
      }
    }
    for (const t of maps) t.dispose();
    this.items.length = 0;
    this.missingAssets.length = 0;
  }

  dispose() {
    this.clear();
    this.group.parent?.remove(this.group);
  }
}

/**
 * 混合模式 → 材质设置。
 *
 * 关键是 `premultipliedAlpha = true`：three 会在片元最后做 `rgb *= a`，
 * 而这个 a 已经包含了纹理 alpha 和 `mat.opacity`（动画的淡入淡出走的就是它）。
 * 不开这一项，下面三种混合都读不到 alpha：
 *
 *   - screen / add 的混合因子里没有 srcAlpha，SVG 抗锯齿边缘那圈半透明像素
 *     会按全强度贡献，贴纸周围一圈光晕；而且 emit-fall-fade 淡出时压根不会变淡，
 *     因为 opacity 只作用在 alpha 上，不作用在 rgb 上。
 *   - multiply 相反：透明区域 rgb=0，乘上去把整块背景压成黑的。
 *
 * multiply 用 (DstColor, OneMinusSrcAlpha) 而不是 three 内置的 MultiplyBlending：
 * 结果是 `dst*(rgb*a) + dst*(1-a)`，即 alpha 越低越趋近「什么都不做」。
 * 这样素材的透明区是黑是白都无所谓，不用要求作者把透明区画成白色，
 * gradient 那条程序化路径也不用为 multiply 单开一个分支。
 *
 * normal（含不写 blend）保持原样：默认直通，输出与加这个字段之前逐位相同。
 */
function applyBlend(mat: THREE.MeshBasicMaterial, blend: ElementBlend = "normal") {
  if (blend === "normal") return;

  mat.premultipliedAlpha = true;
  switch (blend) {
    case "add":
      mat.blending = THREE.AdditiveBlending;
      break;
    case "screen":
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = THREE.OneMinusDstColorFactor;
      mat.blendDst = THREE.OneFactor;
      break;
    case "multiply":
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = THREE.DstColorFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      break;
  }
}

/** 把渐变色的终点变成同色全透明。rgba() 直接改 alpha，其余交给 canvas 解析。 */
function transparentize(color: string): string {
  const rgba = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(",").map((s) => s.trim());
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, 0)`;
  }
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) return `#${hex[1]}00`;
  return "rgba(0,0,0,0)";
}
