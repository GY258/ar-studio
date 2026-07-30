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
import type { ElementBlend, ElementV2, SizeRef } from "./types";
import { getSvg, getSvgAspect, rasterizeSvg, rasterizeText } from "./svg-assets";
import { ensureTextFont } from "./text-font";
import { extractAspect } from "./svg-sanitize";
import { evaluateAnimations } from "./animations";
import type { FaceFrame, FaceTracker } from "./face-tracker";
import type { HandFrame, HandTracker } from "./hand-tracker";

/** 文字统一按这个字号栅格化一次，再按 size 缩放 mesh。避免人一动就重新栅格化。 */
const TEXT_RASTER_PX = 64;

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
