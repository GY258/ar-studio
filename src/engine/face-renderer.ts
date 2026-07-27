import * as THREE from "three";
import { FilesetResolver, FaceLandmarker, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { FaceTrackElement, FaceTrackAnimation } from "./types";
import { SVG_ASSETS, rasterizeSvg, rasterizeText } from "./svg-assets";
import { WASM_BASE } from "@/lib/assets";

/**
 * 人脸追踪渲染器：用 MediaPipe FaceLandmarker 检测关键点，
 * 把泪池、腮红、泪滴等元素锚定到人脸上。
 */

interface FaceMesh {
  mesh: THREE.Mesh;
  elem: FaceTrackElement;
}

export class FaceRenderer {
  private readonly group = new THREE.Group();
  private readonly items: FaceMesh[] = [];
  private landmarker: FaceLandmarker | null = null;
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
    if (this.landmarker) return;
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.tflite",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
  }

  async setElements(elements: FaceTrackElement[], anim?: FaceTrackAnimation) {
    this.clear();
    this.animation = anim ?? null;

    for (const elem of elements) {
      let tex: THREE.Texture;

      if (elem.svgAsset) {
        const svgStr = SVG_ASSETS[elem.svgAsset];
        if (!svgStr) continue;
        const pw = 128;
        const ph = elem.type === "blush" ? 64 : 200;
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
        mat.blending = THREE.AdditiveBlending;
        mat.opacity = 0.5;
      }

      const geo = new THREE.PlaneGeometry(1, 1);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 5;

      if (elem.mirror) {
        mesh.scale.x = -1;
      }

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
    if (!lm || lm.length < 478) {
      // 没检测到脸，隐藏所有元素
      for (const { mesh } of this.items) {
        mesh.visible = false;
      }
      return;
    }

    // IOD: 虹膜间距 (landmarks 468=左虹膜中心, 473=右虹膜中心)
    const lIris = lm[468];
    const rIris = lm[473];
    const iodNorm = Math.hypot(rIris.x - lIris.x, rIris.y - lIris.y);
    const iod = iodNorm * this.W;

    // 面部角度（用于旋转）
    const roll = Math.atan2(rIris.y - lIris.y, rIris.x - lIris.x);

    for (const { mesh, elem } of this.items) {
      mesh.visible = true;

      if (elem.type === "text" && elem.nx !== undefined && elem.ny !== undefined) {
        // 固定屏幕位置的文字
        const wx = (elem.nx - 0.5) * this.W;
        const wy = (0.5 - elem.ny) * this.H;
        const tex = (mesh.material as THREE.MeshBasicMaterial).map;
        if (tex?.image) {
          const img = tex.image as HTMLCanvasElement;
          mesh.scale.set(img.width, img.height, 1);
        }
        mesh.position.set(wx, wy, 3);
        continue;
      }

      if (elem.type === "tear-pool" && elem.landmark !== undefined) {
        const anchor = lm[elem.landmark];
        // 镜像：视频是镜像的，landmark x 需要翻转
        const wx = (0.5 - anchor.x) * this.W;
        const wy = (0.5 - anchor.y) * this.H;
        const scale = iod * (elem.iodScale ?? 0.24);
        const aspect = 200 / 130; // tear-cluster SVG viewBox ratio

        // 呼吸动画
        let sy = 1;
        if (this.animation?.breathe) {
          const a = this.animation.breathe;
          const phase = (Math.sin(t * Math.PI * 2 / a.period) + 1) / 2;
          sy = a.scaleRange[0] + phase * (a.scaleRange[1] - a.scaleRange[0]);
        }

        mesh.scale.set(
          elem.mirror ? -scale : scale,
          scale * aspect * sy,
          1,
        );
        mesh.position.set(wx, wy - scale * 0.3, 3);
        mesh.rotation.z = -roll;
        continue;
      }

      if (elem.type === "trailing-tear" && elem.landmark !== undefined) {
        const anchor = lm[elem.landmark];
        const wx = (0.5 - anchor.x) * this.W;
        const wy = (0.5 - anchor.y) * this.H;
        const baseScale = iod * (elem.iodScale ?? 0.08);

        // 泪滴下落动画
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
            wy - scale_tearOffset(iod, idx) - dropY,
            3,
          );
          (mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
        }
        mesh.rotation.z = -roll;
        continue;
      }

      if (elem.type === "blush") {
        if (elem.landmark !== undefined) {
          const anchor = lm[elem.landmark];
          const wx = (0.5 - anchor.x) * this.W;
          const wy = (0.5 - anchor.y) * this.H;
          const scale = iod * (elem.iodScale ?? 0.4);
          mesh.scale.set(scale, scale * 0.5, 1);
          mesh.position.set(wx, wy, 2.5);
          mesh.rotation.z = -roll;
        }
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

function scale_tearOffset(iod: number, idx: number): number {
  return iod * (0.35 + idx * 0.16);
}
