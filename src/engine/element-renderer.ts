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

/** 轨迹元素额外带的东西：历史缓冲、带的几何、沿途叶子的网格池 */
interface TrailParts {
  buffer: TrailBuffer;
  ribbon: THREE.Mesh;
  ribbonGeo: THREE.BufferGeometry;
  /** 顶点缓冲。容量按 seconds × TRAIL_RATE 预留，运行时不再分配 */
  positions: Float32Array;
  alphas: Float32Array;
  leaves: THREE.Mesh[];
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
  trail?: TrailParts;
  bloom?: BloomParts;
}

export class ElementRenderer {
  private readonly group = new THREE.Group();
  private readonly items: Item[] = [];
  private W = 1280;
  private H = 720;
  private generation = 0;
  /** 最近一次 setElements 的完成信号。离线 harness 必须等纹理栅格化完才能截图。 */
  private pending: Promise<void> = Promise.resolve();

  constructor(scene: THREE.Scene) {
    this.group.renderOrder = 5;
    scene.add(this.group);
  }

  setViewport(w: number, h: number) {
    this.W = w;
    this.H = h;
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

      if (elem.asset.kind === "trail") {
        const parts = await this.buildTrail(elem, elem.asset);
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
            trail: parts,
          });
        }
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
            bloom: parts,
          });
        }
        continue;
      }

      const built = await this.buildTexture(elem);
      if (gen !== this.generation) return;
      if (!built) continue;

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
  ): Promise<TrailParts | null> {
    const maxPts = Math.max(2, Math.ceil(asset.seconds * TRAIL_RATE) + 2);
    // 每个采样点两个顶点（带的两侧），三角带用索引连
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

    const color = new THREE.Color(asset.color);
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

    // 叶子池。容量按「带最长时能放几片」算，够不到的隐藏
    const leaves: THREE.Mesh[] = [];
    if (asset.leaf) {
      const svg = getSvg(asset.leaf.key);
      if (svg) {
        const aspect = getSvgAspect(asset.leaf.key);
        const canvas = await rasterizeSvg(svg, 128, Math.max(1, Math.round(128 * aspect)));
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const count = Math.max(1, Math.ceil(asset.seconds * 4));
        for (let i = 0; i < count; i++) {
          const m = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
          );
          m.renderOrder = 4;
          m.visible = false;
          this.group.add(m);
          leaves.push(m);
        }
      }
    }

    return { buffer: new TrailBuffer(asset.seconds), ribbon, ribbonGeo: geo, positions, alphas, leaves };
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
    if (np) parts.buffer.sample(t, np.x, np.y);

    const pts = parts.buffer.points();
    if (pts.length < 2) {
      parts.ribbon.visible = false;
      for (const l of parts.leaves) l.visible = false;
      return;
    }
    parts.ribbon.visible = true;

    // 归一化 → 世界。和背景平面、人脸、手部守同一个镜像约定：0.5 - x
    const wx = (p: { x: number; y: number }) => (0.5 - p.x) * this.W;
    const wy = (p: { x: number; y: number }) => (0.5 - p.y) * this.H;

    const halfW = (basePx * elem.size.scale) / 2;
    const newest = pts[pts.length - 1].t;
    const { positions, alphas } = parts;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // 切向用中心差分，端点退化成单侧 —— 只看后一个点的话末端会突然歪
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      let dx = wx(next) - wx(prev);
      let dy = wy(next) - wy(prev);
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) {
        dx = 0;
        dy = 1;
      } else {
        dx /= len;
        dy /= len;
      }
      // 法向 = 切向转 90°
      const px = -dy * halfW;
      const py = dx * halfW;
      const cx = wx(p);
      const cy = wy(p);
      const o = i * 6;
      positions[o] = cx + px;
      positions[o + 1] = cy + py;
      positions[o + 2] = 4;
      positions[o + 3] = cx - px;
      positions[o + 4] = cy - py;
      positions[o + 5] = 4;

      // 越老越淡。年龄按时间算而不是按下标：低帧率下点少，按下标算会让淡出速度变快
      const age = (newest - p.t) / Math.max(1e-4, asset.seconds);
      const a = Math.max(0, 1 - age) * (elem.opacity ?? 1);
      alphas[i * 2] = a;
      alphas[i * 2 + 1] = a;
    }

    // 没用到的顶点塌到最后一个点上并置 0 透明度 —— 留着旧数据会拖出一条尾巴
    const last = (pts.length - 1) * 6;
    for (let i = pts.length; i * 6 + 5 < positions.length; i++) {
      const o = i * 6;
      for (let k = 0; k < 6; k++) positions[o + k] = positions[last + k];
      alphas[i * 2] = 0;
      alphas[i * 2 + 1] = 0;
    }

    parts.ribbonGeo.attributes.position.needsUpdate = true;
    parts.ribbonGeo.attributes.aAlpha.needsUpdate = true;
    parts.ribbonGeo.setDrawRange(0, Math.max(0, (pts.length - 1) * 6));

    this.placeLeaves(parts, asset, basePx, pts, wx, wy, newest);
  }

  /**
   * 沿带的弧长摆叶子。
   *
   * 位置完全由 hash(第几片, seed) 和弧长决定 —— **不占额外状态**。
   * 每片叶子存「什么时候长出来的」会把 append-only 的简单性搞没，
   * 而且没必要：弧长本身就是单调增长的，用它当「第几片」的坐标即可。
   */
  private placeLeaves(
    parts: TrailParts,
    asset: Extract<ElementAsset, { kind: "trail" }>,
    basePx: number,
    pts: readonly { x: number; y: number; t: number }[],
    wx: (p: { x: number; y: number }) => number,
    wy: (p: { x: number; y: number }) => number,
    newest: number,
  ) {
    const leaf = asset.leaf;
    if (!leaf || !parts.leaves.length) return;

    const spacingPx = leaf.spacing * basePx;
    const sizePx = leaf.scale * basePx;
    // 从最新的一端往老的方向走弧长，这样新长出来的叶子位置稳定，
    // 不会因为尾巴被裁掉而整排跳一格
    let acc = 0;
    let leafIdx = 0;
    for (let i = pts.length - 1; i > 0 && leafIdx < parts.leaves.length; i--) {
      const ax = wx(pts[i]);
      const ay = wy(pts[i]);
      const bx = wx(pts[i - 1]);
      const by = wy(pts[i - 1]);
      const seg = Math.hypot(bx - ax, by - ay);
      if (seg < 1e-4) continue;
      let need = spacingPx * (leafIdx + 1) - acc;
      while (need <= seg && leafIdx < parts.leaves.length) {
        const f = need / seg;
        const m = parts.leaves[leafIdx];
        const h = hash1(leafIdx, leaf.seed);
        // 左右交替但不严格轮换：严格轮换看起来像装饰花边，不像长出来的
        const side = h > 0.5 ? 1 : -1;
        const dirX = (bx - ax) / seg;
        const dirY = (by - ay) / seg;
        const nx = -dirY * side;
        const ny = dirX * side;
        const off = sizePx * 0.42;
        m.visible = true;
        m.position.set(ax + dirX * need + nx * off, ay + dirY * need + ny * off, 5);
        const s = sizePx * (0.75 + hash1(leafIdx + 31, leaf.seed) * 0.5);
        m.scale.set(s * side, s, 1);
        m.rotation.z = Math.atan2(dirY, dirX) + (side > 0 ? -0.6 : 0.6);
        (m.material as THREE.MeshBasicMaterial).opacity = Math.max(
          0,
          1 - (newest - pts[i].t) / Math.max(1e-4, asset.seconds),
        );
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

  /** 清掉所有跨帧状态。切模板和时间倒流时调 —— 见 engine.stepTo。 */
  resetState() {
    for (const it of this.items) {
      it.trail?.buffer.clear();
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

      if (item.trail) {
        this.updateTrail(item, elem, t, basePx, face, hand, tracker, handTracker);
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
    for (const { mesh } of this.items) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.items.length = 0;
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
