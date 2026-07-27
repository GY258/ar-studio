import * as THREE from "three";
import { FilesetResolver, FaceLandmarker, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { FaceTrackElement, FaceTrackAnimation } from "./types";
import { SVG_ASSETS, rasterizeSvg, rasterizeText } from "./svg-assets";
import { WASM_BASE } from "@/lib/assets";

interface FaceMesh {
  mesh: THREE.Mesh;
  elem: FaceTrackElement;
}

export class FaceRenderer {
  private readonly group = new THREE.Group();
  private readonly items: FaceMesh[] = [];
  private landmarker: FaceLandmarker | null = null;
  private loading = false;
  private W = 1280;
  private H = 720;
  private animation: FaceTrackAnimation | null = null;
  private lastLandmarks: { x: number; y: number; z: number }[] | null = null;

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
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.tflite",
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

    for (const elem of elements) {
      let tex: THREE.Texture;

      if (elem.type === "blush") {
        // 腮红：程序化绘制粉色径向渐变椭圆
        const c = document.createElement("canvas");
        c.width = 128; c.height = 64;
        const ctx = c.getContext("2d")!;
        const grd = ctx.createRadialGradient(64, 32, 0, 64, 32, 60);
        grd.addColorStop(0, "rgba(242,147,126,0.5)");
        grd.addColorStop(1, "rgba(242,147,126,0)");
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, 128, 64);
        tex = new THREE.CanvasTexture(c);
      } else if (elem.svgAsset) {
        const svgStr = SVG_ASSETS[elem.svgAsset];
        if (!svgStr) continue;
        const pw = 128;
        const aspect = elem.svgAsset === "tear-cluster" ? 200 / 130 : 1.5;
        const ph = Math.round(pw * aspect);
        const canvas = await rasterizeSvg(svgStr, pw, ph);
        tex = new THREE.CanvasTexture(canvas);
      } else if (elem.text) {
        const fontSize = Math.round(this.W * (elem.fontSizeW ?? 0.08));
        const canvas = rasterizeText(
          elem.text,
          fontSize,
          elem.color ?? "#FFFFFF",
          700,
          elem.shadow,
        );
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

      this.items.push({ mesh, elem });
      this.group.add(mesh);
    }
  }

  detectFace(video: HTMLVideoElement, nowMs: number) {
    if (!this.landmarker) return;
    try {
      const result: FaceLandmarkerResult = this.landmarker.detectForVideo(video, nowMs);
      if (result.faceLandmarks && result.faceLandmarks.length > 0) {
        this.lastLandmarks = result.faceLandmarks[0];
      } else {
        this.lastLandmarks = null;
      }
    } catch {
      // skip frame
    }
  }

  update(t: number) {
    const lm = this.lastLandmarks;
    const hasFace = lm && lm.length >= 478;

    // 计算 IOD 和 roll（有脸时）
    let iod = 0;
    let roll = 0;
    if (hasFace) {
      const lIris = lm[468];
      const rIris = lm[473];
      iod = Math.hypot((rIris.x - lIris.x) * this.W, (rIris.y - lIris.y) * this.H);
      roll = Math.atan2(rIris.y - lIris.y, rIris.x - lIris.x);
    }

    for (const { mesh, elem } of this.items) {
      // 固定屏幕位置的文字：始终显示
      if (elem.type === "text" && elem.nx !== undefined && elem.ny !== undefined) {
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

      // 需要人脸的元素：没检测到脸就隐藏
      if (!hasFace) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;

      if (elem.type === "tear-pool" && elem.landmark !== undefined) {
        const anchor = lm[elem.landmark];
        const wx = (0.5 - anchor.x) * this.W;
        const wy = (0.5 - anchor.y) * this.H;
        const scale = iod * (elem.iodScale ?? 0.24);
        const aspect = 200 / 130;

        let sy = 1;
        if (this.animation?.breathe) {
          const a = this.animation.breathe;
          const phase = (Math.sin(t * Math.PI * 2 / a.period) + 1) / 2;
          sy = a.scaleRange[0] + phase * (a.scaleRange[1] - a.scaleRange[0]);
        }

        const sw = elem.mirror ? -scale : scale;
        mesh.scale.set(sw, scale * aspect * sy, 1);
        mesh.position.set(wx, wy - scale * 0.3, 3);
        mesh.rotation.z = -roll;
        continue;
      }

      if (elem.type === "trailing-tear" && elem.landmark !== undefined) {
        const anchor = lm[elem.landmark];
        const wx = (0.5 - anchor.x) * this.W;
        const wy = (0.5 - anchor.y) * this.H;
        const baseScale = iod * (elem.iodScale ?? 0.08);

        if (this.animation?.tears) {
          const a = this.animation.tears;
          const idx = parseInt(elem.id.slice(-1)) || 0;
          const phase = ((t + idx * a.phaseShift) % a.period) / a.period;
          const dropY = phase * iod * a.distance;
          const opacity = phase < 0.1 ? phase / 0.1 : phase > 0.8 ? (1 - phase) / 0.2 : 1;
          const shrink = 1 - idx * 0.15;

          mesh.scale.set(baseScale * shrink, baseScale * 1.5 * shrink, 1);
          mesh.position.set(
            wx + (elem.mirror ? -1 : 1) * iod * 0.04,
            wy - iod * (0.35 + idx * 0.16) - dropY,
            3,
          );
          (mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
        }
        mesh.rotation.z = -roll;
        continue;
      }

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
