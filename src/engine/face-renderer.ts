import * as THREE from "three";
import { FilesetResolver, FaceLandmarker, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { FaceTrackElement, FaceTrackAnimation } from "./types";
import { getSvg, getSvgAspect, rasterizeSvg, rasterizeText } from "./svg-assets";
import { WASM_BASE, FACE_MODEL } from "@/lib/assets";
import { resolveLandmark } from "./anchors";
import { evaluateAnimations, type AnimationV2 } from "./animations";

interface FaceMesh {
  mesh: THREE.Mesh;
  elem: FaceTrackElement;
  /** v1 兼容：从 face_track_animation 转换来的动画 */
  resolvedAnimations?: AnimationV2[];
  /** v1 兼容：trailing-tear 的序号（替代 id.slice(-1)） */
  trailIndex: number;
}

export class FaceRenderer {
  private readonly group = new THREE.Group();
  private readonly items: FaceMesh[] = [];
  private landmarker: FaceLandmarker | null = null;
  private loading = false;
  private generation = 0;
  private W = 1280;
  private H = 720;
  private animation: FaceTrackAnimation | null = null;
  private lastLandmarks: { x: number; y: number; z: number }[] | null = null;
  private lastFaceTime = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.group.renderOrder = 5;
    scene.add(this.group);
  }

  setViewport(w: number, h: number) { this.W = w; this.H = h; }

  async loadFaceMesh(): Promise<void> {
    if (this.landmarker || this.loading) return;
    this.loading = true;
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: false,
      });
    } finally { this.loading = false; }
  }

  async setElements(elements: FaceTrackElement[], anim?: FaceTrackAnimation) {
    this.clear();
    this.animation = anim ?? null;
    const gen = this.generation;

    // v1 兼容：按 landmark 分组计算 trailing-tear 序号
    const trailCounters = new Map<string, number>();

    for (const elem of elements) {
      if (gen !== this.generation) return;

      // --- 纹理创建：统一由 svgAsset / text / type 决定 ---
      let tex: THREE.Texture;
      let blending = THREE.NormalBlending;

      if (elem.svgAsset) {
        const svgStr = getSvg(elem.svgAsset);
        if (!svgStr) continue;
        const aspect = getSvgAspect(elem.svgAsset);
        const pw = 128;
        const ph = Math.round(pw * aspect);
        const canvas = await rasterizeSvg(svgStr, pw, ph);
        if (gen !== this.generation) return;
        tex = new THREE.CanvasTexture(canvas);
      } else if (elem.text) {
        const fontSize = Math.round(this.W * (elem.fontSizeW ?? 0.03));
        const canvas = rasterizeText(
          elem.text, fontSize,
          elem.color ?? "#FFFFFF",
          elem.fontWeight ?? 600,
          elem.shadow,
        );
        tex = new THREE.CanvasTexture(canvas);
      } else if (elem.type === "blush") {
        // v1 兼容：blush 用程序化渐变椭圆
        const c = document.createElement("canvas");
        c.width = 128; c.height = 64;
        const ctx = c.getContext("2d")!;
        const color = elem.color ?? "rgba(242,147,126,0.5)";
        const grd = ctx.createRadialGradient(64, 32, 0, 64, 32, 60);
        grd.addColorStop(0, color);
        grd.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, 128, 64);
        tex = new THREE.CanvasTexture(c);
        // v1 → v2：设 opacity，update 统一读
        if (elem.opacity === undefined) elem.opacity = 0.5;
        console.warn(`[compat] "${elem.id}" uses type:"blush". Migrate to asset:{kind:"gradient"}`);
      } else {
        continue;
      }

      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: false, blending,
      });

      const geo = new THREE.PlaneGeometry(1, 1);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 5;
      if (elem.rotation) mesh.rotation.z = (-elem.rotation * Math.PI) / 180;

      // v1 兼容：计算 trail 序号（替代 id.slice(-1)）
      let trailIndex = 0;
      if (elem.type === "trailing-tear" && elem.landmark !== undefined) {
        const key = String(elem.landmark) + (elem.mirror ? "-r" : "-l");
        trailIndex = trailCounters.get(key) ?? 0;
        trailCounters.set(key, trailIndex + 1);
      }

      // v1 兼容：tear-pool 自动加 offsetY 让顶部对齐眼睑
      if (elem.type === "tear-pool" && elem.offsetY === undefined) {
        const aspect = elem.svgAsset ? getSvgAspect(elem.svgAsset) : 1;
        elem.offsetY = (elem.iodScale ?? 0.28) * aspect * 0.5;
      }

      // v1 兼容：从 face_track_animation 构建元素级动画
      let resolvedAnimations = elem.animations;
      if (!resolvedAnimations && this.animation) {
        if (elem.type === "tear-pool" && this.animation.breathe) {
          resolvedAnimations = [{ preset: "pulse" as const, ...this.animation.breathe }];
        } else if (elem.type === "trailing-tear" && this.animation.tears?.period > 0) {
          const a = this.animation.tears;
          resolvedAnimations = [{
            preset: "emit-fall-fade" as const,
            distance: a.distance,
            period: a.period,
            phase: (trailIndex * a.phaseShift) / a.period,
          }];
        }
      }

      this.items.push({ mesh, elem, resolvedAnimations, trailIndex });
      this.group.add(mesh);
    }
  }

  detectFace(video: HTMLVideoElement, nowMs: number) {
    if (!this.landmarker) return;
    try {
      const result: FaceLandmarkerResult = this.landmarker.detectForVideo(video, nowMs);
      if (result.faceLandmarks && result.faceLandmarks.length > 0) {
        this.lastLandmarks = result.faceLandmarks[0];
        this.lastFaceTime = nowMs;
      }
    } catch { /* skip frame */ }
  }

  update(t: number) {
    const lm = this.lastLandmarks;
    const elapsed = performance.now() - this.lastFaceTime;
    const hasFace = lm && lm.length >= 478 && elapsed < 500;

    const getLm = (landmark: string | number | undefined) => {
      if (landmark === undefined || !lm) return null;
      const idx = resolveLandmark(landmark);
      return idx !== null && idx < lm.length ? lm[idx] : null;
    };

    let iod = 0, roll = 0;
    if (hasFace) {
      const lIris = lm[468], rIris = lm[473];
      iod = Math.hypot((rIris.x - lIris.x) * this.W, (rIris.y - lIris.y) * this.H);
      roll = Math.atan2(rIris.y - lIris.y, rIris.x - lIris.x);
    }

    for (const { mesh, elem, resolvedAnimations } of this.items) {
      const mat = mesh.material as THREE.MeshBasicMaterial;

      // --- 屏幕空间元素（无 landmark）：始终显示 ---
      if (elem.nx !== undefined && elem.ny !== undefined && elem.landmark === undefined) {
        mesh.visible = true;
        const wx = (elem.nx - 0.5) * this.W;
        const wy = (0.5 - elem.ny) * this.H;
        if (mat.map?.image) {
          const img = mat.map.image as HTMLCanvasElement;
          mesh.scale.set(img.width, img.height, 1);
        }
        mesh.position.set(wx, wy, 3);
        continue;
      }

      // --- 人脸空间元素：需要人脸 ---
      if (!hasFace) { mesh.visible = false; continue; }
      mesh.visible = true;

      const anchor = getLm(elem.landmark ?? "nose_bridge");
      if (!anchor) continue;
      const ax = (0.5 - anchor.x) * this.W;
      const ay = (0.5 - anchor.y) * this.H;

      // 基础尺寸
      const baseScale = iod * (elem.iodScale ?? 0.25);
      const svgAspect = elem.svgAsset ? getSvgAspect(elem.svgAsset) : (elem.aspect ?? 1);
      // 文字用纹理自身比例
      let texAspect = svgAspect;
      if (elem.text && mat.map?.image) {
        const img = mat.map.image as HTMLCanvasElement;
        texAspect = img.height / img.width;
      }

      // 偏移（IOD 单位）
      const offX = (elem.offsetX ?? 0) * iod;
      const offY = -(elem.offsetY ?? 0) * iod;

      // 应用动画
      const anim = evaluateAnimations(resolvedAnimations, t, this.H, iod);

      // 旋转偏移跟随头部
      const cosR = Math.cos(-roll), sinR = Math.sin(-roll);
      const totalOffX = offX + anim.outwardX * (elem.mirror ? -1 : 1);
      const totalOffY = offY + anim.positionY;
      const rotOx = totalOffX * cosR - totalOffY * sinR;
      const rotOy = totalOffX * sinR + totalOffY * cosR;

      // 尺寸
      const sw = baseScale * anim.scaleX * (elem.mirror ? -1 : 1);
      const sh = baseScale * texAspect * anim.scaleY;

      mesh.scale.set(sw, sh, 1);
      mesh.position.set(ax + rotOx, ay + rotOy, 3);
      mat.opacity = anim.opacity * (elem.opacity ?? 1);

      // 自身旋转 + 头部 roll
      const selfRot = elem.rotation ? (-elem.rotation * Math.PI / 180) : 0;
      mesh.rotation.z = selfRot - roll;
    }
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
    this.lastLandmarks = null;
  }

  dispose() {
    this.clear();
    this.landmarker?.close();
    this.group.parent?.remove(this.group);
  }
}
