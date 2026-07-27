import * as THREE from "three";
import type { OverlayElement } from "./types";
import { SVG_ASSETS, rasterizeSvg, rasterizeText } from "./svg-assets";

export class OverlayRenderer {
  private readonly group = new THREE.Group();
  private readonly meshes: { mesh: THREE.Mesh; elem: OverlayElement; baseY: number }[] = [];
  private W = 1280;
  private H = 720;
  private generation = 0;

  constructor(scene: THREE.Scene) {
    this.group.renderOrder = 4;
    scene.add(this.group);
  }

  setViewport(w: number, h: number) {
    this.W = w;
    this.H = h;
    this.relayout();
  }

  async setElements(elements: OverlayElement[]) {
    this.clear();
    const gen = this.generation;

    for (const elem of elements) {
      if (gen !== this.generation) return; // 已切换模板，放弃

      let tex: THREE.Texture;
      if (elem.type === "svg" && elem.svgAsset) {
        const svgStr = SVG_ASSETS[elem.svgAsset];
        if (!svgStr) continue;
        const pw = Math.round(this.W * elem.sizeW * 2);
        const ph = Math.round(pw * (elem.aspect ?? 1));
        const canvas = await rasterizeSvg(svgStr, pw, ph);
        if (gen !== this.generation) return;
        tex = new THREE.CanvasTexture(canvas);
      } else if (elem.type === "text" && elem.text) {
        const fontSize = Math.round(this.W * (elem.fontSizeW ?? 0.03));
        const canvas = rasterizeText(
          elem.text,
          fontSize,
          elem.color ?? "#FFFFFF",
          elem.fontWeight ?? 600,
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
      const geo = new THREE.PlaneGeometry(1, 1);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 4;

      if (elem.rotation) {
        mesh.rotation.z = (-elem.rotation * Math.PI) / 180;
      }

      this.meshes.push({ mesh, elem, baseY: 0 });
      this.group.add(mesh);
    }
    this.relayout();
  }

  private relayout() {
    for (const { mesh, elem } of this.meshes) {
      const tex = (mesh.material as THREE.MeshBasicMaterial).map;
      if (!tex || !tex.image) continue;
      const img = tex.image as HTMLCanvasElement | HTMLImageElement;
      const aspect = img.height / img.width;
      const w = this.W * elem.sizeW;
      const h = w * aspect;
      mesh.scale.set(w, h, 1);
      const wx = (elem.nx - 0.5) * this.W;
      const wy = (0.5 - elem.ny) * this.H;
      mesh.position.set(wx, wy, 2);
    }
    for (const entry of this.meshes) {
      entry.baseY = entry.mesh.position.y;
    }
  }

  update(t: number) {
    for (const { mesh, elem, baseY } of this.meshes) {
      if (elem.float) {
        const offset = Math.sin(t * (Math.PI * 2) / elem.float.period) * this.H * elem.float.amplitude;
        mesh.position.y = baseY + offset;
      }
    }
  }

  clear() {
    this.generation++;
    for (const { mesh } of this.meshes) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.meshes.length = 0;
  }

  dispose() {
    this.clear();
    this.group.parent?.remove(this.group);
  }
}
