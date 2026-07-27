import * as THREE from "three";
import { FilesetResolver, FaceLandmarker, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { FaceTrackElement, FaceTrackAnimation } from "./types";
import { SVG_ASSETS, rasterizeSvg, rasterizeText } from "./svg-assets";
import { WASM_BASE, FACE_MODEL } from "@/lib/assets";

interface FaceMesh {
  mesh: THREE.Mesh;
  elem: FaceTrackElement;
  baseOffsetY: number;
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

  setViewport(w: number, h: number) {
    this.W = w;
    this.H = h;
  }

  async loadFaceMesh(): Promise<void> {
    if (this.landmarker || this.loading) return;
    this.loading = true;
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: FACE_MODEL,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: false,
      });
    } finally {
      this.loading = false;
    }
  }

  async setElements(elements: FaceTrackElement[], anim?: FaceTrackAnimation) {
    this.clear();
    this.animation = anim ?? null;
    const gen = this.generation;

    for (const elem of elements) {
      if (gen !== this.generation) return;
      let tex: THREE.Texture;

      if (elem.type === "blush") {
        const c = document.createElement("canvas");
        c.width = 128; c.height = 64;
        const ctx = c.getContext("2d")!;
        const grd = ctx.createRadialGradient(64, 32, 0, 64, 32, 60);
        grd.addColorStop(0, "rgba(242,147,126,0.5)");
        grd.addColorStop(1, "rgba(242,147,126,0)");
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, 128, 64);
        tex = new THREE.CanvasTexture(c);
      } else if (elem.type === "sticker" && elem.svgAsset) {
        const svgStr = SVG_ASSETS[elem.svgAsset];
        if (!svgStr) continue;
        const pw = 128;
        const ph = Math.round(pw * (elem.aspect ?? 1));
        const canvas = await rasterizeSvg(svgStr, pw, ph);
        if (gen !== this.generation) return;
        tex = new THREE.CanvasTexture(canvas);
      } else if ((elem.type === "sticker" || elem.type === "text") && elem.text) {
        const fontSize = Math.round(this.W * (elem.fontSizeW ?? 0.03));
        const canvas = rasterizeText(
          elem.text,
          fontSize,
          elem.color ?? "#FFFFFF",
          elem.fontWeight ?? 600,
          elem.shadow,
        );
        tex = new THREE.CanvasTexture(canvas);
      } else if (elem.type === "text" && elem.text) {
        const fontSize = Math.round(this.W * (elem.fontSizeW ?? 0.08));
        const canvas = rasterizeText(
          elem.text,
          fontSize,
          elem.color ?? "#FFFFFF",
          700,
          elem.shadow,
        );
        tex = new THREE.CanvasTexture(canvas);
      } else if (elem.svgAsset) {
        const svgStr = SVG_ASSETS[elem.svgAsset];
        if (!svgStr) continue;
        const pw = 128;
        const aspect = elem.svgAsset === "tear-cluster" ? 200 / 130 : 1.5;
        const ph = Math.round(pw * aspect);
        const canvas = await rasterizeSvg(svgStr, pw, ph);
        if (gen !== this.generation) return;
        tex = new THREE.CanvasTexture(canvas);
      } else {
        continue;
      }

      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      });

      if (elem.type === "blush") {
        mat.blending = THREE.NormalBlending;
      }

      const geo = new THREE.PlaneGeometry(1, 1);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 5;

      if (elem.rotation) {
        mesh.rotation.z = (-elem.rotation * Math.PI) / 180;
      }

      this.items.push({ mesh, elem, baseOffsetY: 0 });
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
      // 不立即清空 lastLandmarks，让 update 根据时间判断
    } catch {
      // skip frame
    }
  }

  update(t: number) {
    const lm = this.lastLandmarks;
    // 丢帧容忍：0.5 秒内保持上一帧位置，超过才隐藏
    const elapsed = performance.now() - this.lastFaceTime;
    const hasFace = lm && lm.length >= 478 && elapsed < 500;

    let iod = 0;
    let roll = 0;
    let noseBridgeX = 0;
    let noseBridgeY = 0;

    if (hasFace) {
      const lIris = lm[468];
      const rIris = lm[473];
      iod = Math.hypot((rIris.x - lIris.x) * this.W, (rIris.y - lIris.y) * this.H);
      roll = Math.atan2(rIris.y - lIris.y, rIris.x - lIris.x);
      // 鼻梁 = 两虹膜中点
      noseBridgeX = (0.5 - (lIris.x + rIris.x) / 2) * this.W;
      noseBridgeY = (0.5 - (lIris.y + rIris.y) / 2) * this.H;
    }

    for (const item of this.items) {
      const { mesh, elem } = item;

      // 固定屏幕位置的文字（如 (T_T)）：始终显示
      if (elem.type === "text" && elem.nx !== undefined && elem.ny !== undefined && elem.landmark === undefined) {
        mesh.visible = true;
        const wx = (elem.nx - 0.5) * this.W;
        const wy = (0.5 - elem.ny) * this.H;
        const texMap = (mesh.material as THREE.MeshBasicMaterial).map;
        if (texMap?.image) {
          const img = texMap.image as HTMLCanvasElement;
          mesh.scale.set(img.width, img.height, 1);
        }
        mesh.position.set(wx, wy, 3);
        continue;
      }

      // 需要人脸的元素
      if (!hasFace) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;

      // --- sticker 类型：相对锚点定位，跟随人脸 ---
      if (elem.type === "sticker") {
        const anchorIdx = elem.landmark ?? 168;
        const anchor = lm[anchorIdx];
        const ax = (0.5 - anchor.x) * this.W;
        const ay = (0.5 - anchor.y) * this.H;

        // 偏移量以 IOD 为单位（offsetY 正 = 往下，Three.js Y 正 = 往上，取反）
        const ox = (elem.offsetX ?? 0) * iod;
        const oy = -(elem.offsetY ?? 0) * iod;

        // 旋转偏移量跟随头部 roll
        const cosR = Math.cos(-roll);
        const sinR = Math.sin(-roll);
        const rotOx = ox * cosR - oy * sinR;
        const rotOy = ox * sinR + oy * cosR;

        // 大小以 IOD 为单位
        const scale = iod * (elem.iodScale ?? 0.25);
        const aspect = elem.aspect ?? 1;

        // 浮动动画
        let floatOff = 0;
        if (elem.float) {
          floatOff = Math.sin(t * Math.PI * 2 / elem.float.period) * iod * elem.float.amplitude;
        }

        const texMap = (mesh.material as THREE.MeshBasicMaterial).map;
        if (texMap?.image) {
          const img = texMap.image as HTMLCanvasElement;
          const imgAspect = img.height / img.width;
          mesh.scale.set(scale, scale * imgAspect, 1);
        } else {
          mesh.scale.set(scale, scale * aspect, 1);
        }

        mesh.position.set(ax + rotOx, ay + rotOy + floatOff, 3);
        // 保持元素自身旋转 + 头部 roll
        const selfRot = elem.rotation ? (-elem.rotation * Math.PI / 180) : 0;
        mesh.rotation.z = selfRot - roll;
        continue;
      }

      // --- tear-pool: T 型固定在眼下不动 ---
      if (elem.type === "tear-pool" && elem.landmark !== undefined) {
        const anchor = lm[elem.landmark];
        const wx = (0.5 - anchor.x) * this.W;
        const wy = (0.5 - anchor.y) * this.H;
        const scale = iod * (elem.iodScale ?? 0.28);
        const aspect = 28 / 52; // tear-bar SVG viewBox ratio

        const sw = elem.mirror ? -scale : scale;
        const h = scale * aspect;
        mesh.scale.set(sw, h, 1);
        mesh.position.set(wx, wy - h * 0.5, 3);
        mesh.rotation.z = -roll;
        (mesh.material as THREE.MeshBasicMaterial).opacity = 1;
        continue;
      }

      // --- trailing-tear: 水滴从眼下冒出然后往下掉 ---
      if (elem.type === "trailing-tear" && elem.landmark !== undefined) {
        const anchor = lm[elem.landmark];
        const wx = (0.5 - anchor.x) * this.W;
        const wy = (0.5 - anchor.y) * this.H;
        const idx = parseInt(elem.id.slice(-1)) || 0;
        const baseScale = iod * (elem.iodScale ?? 0.09);

        if (this.animation?.tears && this.animation.tears.period > 0) {
          const a = this.animation.tears;
          // 每滴错开 phaseShift 秒
          const phase = ((t + idx * a.phaseShift) % a.period) / a.period;

          // 0~0.15: 在眼下冒出（从小变大）
          // 0.15~0.85: 往下掉
          // 0.85~1: 淡出消失
          let scale: number, dropY: number, opacity: number;

          if (phase < 0.15) {
            // 冒出阶段
            const p = phase / 0.15;
            scale = baseScale * p;
            dropY = 0;
            opacity = p;
          } else if (phase < 0.85) {
            // 下落阶段
            const p = (phase - 0.15) / 0.70;
            scale = baseScale * (1 - p * 0.3); // 下落时略微缩小
            dropY = p * iod * a.distance;
            opacity = 0.9;
          } else {
            // 淡出阶段
            const p = (phase - 0.85) / 0.15;
            scale = baseScale * 0.7;
            dropY = iod * a.distance;
            opacity = 1 - p;
          }

          mesh.scale.set(scale, scale * 1.4, 1); // 水滴比圆稍长
          // 沿脸颊往下，略向外偏移
          const outward = (elem.mirror ? -1 : 1) * dropY * 0.08;
          mesh.position.set(wx + outward, wy - dropY - iod * 0.1, 3);
          (mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
        }
        mesh.rotation.z = -roll;
        continue;
      }

      // --- blush ---
      if (elem.type === "blush" && elem.landmark !== undefined) {
        const anchor = lm[elem.landmark];
        const wx = (0.5 - anchor.x) * this.W;
        const wy = (0.5 - anchor.y) * this.H;
        const scale = iod * (elem.iodScale ?? 0.4);
        mesh.scale.set(scale, scale * 0.5, 1);
        mesh.position.set(wx, wy, 2.5);
        mesh.rotation.z = -roll;
        continue;
      }
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
