import * as THREE from "three";
import type { OccupancyField } from "./occupancy";
import type { Emitter, Substance } from "./types";

/**
 * 粒子池：固定容量循环复用，不在循环内分配对象（PRD 5.2）。
 *
 * 一套数据两种渲染：
 *  - 圆点（雪、溅起的水珠）走 Points
 *  - 液体走沿速度方向拉伸的 instanced 胶囊
 *
 * 为什么不用 LineSegments 画液体：WebGL 里 gl.lineWidth 在 Chrome/ANGLE 上恒等于 1
 * 设备像素，2x 屏上就是半个 CSS 像素的头发丝，改任何参数都救不回来。
 */

const MAX = 9000;
const NORMAL_EPS = 10; // 求表面法线的差分步长，世界像素

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class ParticleSystem {
  private readonly px = new Float32Array(MAX);
  private readonly py = new Float32Array(MAX);
  private readonly vx = new Float32Array(MAX);
  private readonly vy = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly siz = new Float32Array(MAX);
  private readonly phase = new Float32Array(MAX);
  /**
   * 每颗自己的闪烁频率。全场同一个频率时眼睛会认出那个周期，
   * 读作「整体在频闪」而不是「颗粒各自在闪」—— 只有相位不同是不够的。
   */
  private readonly freq = new Float32Array(MAX);
  /**
   * 深度 z ∈ [0,1]，0 = 最远。近处大、快、亮，远处小、慢、淡。
   *
   * 取值范围和「0 是最远」这个约定现在就钉死：P-1（粒子被人体遮挡）要用同一个 z
   * 判定这颗粒子在人前还是人后，改了这里那条就得跟着改。
   *
   * TODO: 用的是 Math.random()。粒子目前不参与 L2（renderAt 不 step 粒子），
   * 将来要把粒子纳入渲染回归的话，这里连同 emit/splash 里其余的 random 都得换成
   * 调用方传入的播种 rng，否则「同一份输入渲染多少次都是同一张图」不再成立。
   */
  private readonly depth = new Float32Array(MAX);
  private readonly streak = new Float32Array(MAX);
  private readonly settled = new Uint8Array(MAX);
  private readonly isSplash = new Uint8Array(MAX);
  private cursor = 0;
  private acc = 0;

  // 圆点
  private readonly dotPos = new Float32Array(MAX * 3);
  private readonly dotCol = new Float32Array(MAX * 3);
  private readonly dotSiz = new Float32Array(MAX);
  private readonly dotAlp = new Float32Array(MAX);
  private readonly dotGeo = new THREE.BufferGeometry();
  private readonly dotMat: THREE.ShaderMaterial;
  readonly dots: THREE.Points;

  // 液体胶囊
  private readonly liqPos = new Float32Array(MAX * 2);
  private readonly liqDir = new Float32Array(MAX * 2);
  private readonly liqLen = new Float32Array(MAX);
  private readonly liqRad = new Float32Array(MAX);
  private readonly liqAlp = new Float32Array(MAX);
  private readonly liqAttr: Record<string, THREE.InstancedBufferAttribute> = {};
  private readonly liqMat: THREE.ShaderMaterial;
  readonly liquid: THREE.Mesh;

  constructor() {
    this.dotGeo.setAttribute("position", new THREE.BufferAttribute(this.dotPos, 3));
    this.dotGeo.setAttribute("pcolor", new THREE.BufferAttribute(this.dotCol, 3));
    this.dotGeo.setAttribute("psize", new THREE.BufferAttribute(this.dotSiz, 1));
    this.dotGeo.setAttribute("palpha", new THREE.BufferAttribute(this.dotAlp, 1));

    this.dotMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      // gl_PointSize 的单位是设备像素，不乘 dpr 的话 2x 屏上粒子直接小一半
      uniforms: { uDpr: { value: 1 } },
      vertexShader: `
        uniform float uDpr;
        attribute vec3 pcolor; attribute float psize; attribute float palpha;
        varying vec3 vC; varying float vA;
        void main(){
          vC = pcolor; vA = palpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * 2.0 * uDpr;
        }`,
      /*
       * 亮核 + 一圈暗边。
       *
       * 暗边是为了让白雪在白墙上还能读出来：普通混合下纯白粒子叠在浅色背景上
       * 几乎没有对比度，只有把外沿压暗一点，眼睛才认得出这是一颗一颗的东西。
       * 加法混合时这圈暗边会被加成一起变亮，等于自动失效，正好不影响金粉那类发光物质。
       *
       * 这几个数是在离线 harness 的浅灰背景上定的，真机对着白墙还要再调。
       */
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float core = smoothstep(0.5, 0.0, d);
          float rim  = smoothstep(0.5, 0.34, d) - core;
          gl_FragColor = vec4(mix(vC, vC * 0.45, rim), max(core, rim * 0.55) * vA);
        }`,
    });
    this.dots = new THREE.Points(this.dotGeo, this.dotMat);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 2;

    const quad = new THREE.PlaneGeometry(1, 1);
    const liqGeo = new THREE.InstancedBufferGeometry();
    liqGeo.index = quad.index;
    liqGeo.attributes.position = quad.attributes.position;
    const spec: [string, Float32Array, number][] = [
      ["iPos", this.liqPos, 2],
      ["iDir", this.liqDir, 2],
      ["iLen", this.liqLen, 1],
      ["iRad", this.liqRad, 1],
      ["iAlp", this.liqAlp, 1],
    ];
    for (const [name, arr, n] of spec) {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      liqGeo.setAttribute(name, a);
      this.liqAttr[name] = a;
    }
    liqGeo.instanceCount = MAX;

    this.liqMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      uniforms: {
        uCol: { value: new THREE.Color(0.6, 0.84, 1) },
        uGloss: { value: 0.85 },
      },
      vertexShader: `
        attribute vec2 iPos; attribute vec2 iDir;
        attribute float iLen; attribute float iRad; attribute float iAlp;
        varying float vA; varying vec2 vP; varying float vLen; varying float vRad;
        void main(){
          vA = iAlp; vLen = iLen; vRad = iRad;
          vec2 loc = vec2(position.x * 2.0 * (iLen + iRad), position.y * 2.0 * iRad);
          vP = loc;
          vec2 r = iDir, u = vec2(-iDir.y, iDir.x);
          vec2 w = iPos + r * loc.x + u * loc.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 0.0, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uCol; uniform float uGloss;
        varying float vA; varying vec2 vP; varying float vLen; varying float vRad;
        void main(){
          if (vA < 0.004 || vRad <= 0.0) discard;
          float d = length(vec2(max(abs(vP.x) - vLen, 0.0), vP.y));   // 胶囊距离场
          if (d > vRad) discard;
          float a = smoothstep(vRad, vRad * 0.15, d);
          float k = pow(1.0 - d / vRad, 3.0);                          // 亮核，当高光
          gl_FragColor = vec4(mix(uCol, vec3(1.0), k * uGloss), a * vA);
        }`,
    });
    this.liquid = new THREE.Mesh(liqGeo, this.liqMat);
    this.liquid.frustumCulled = false;
    this.liquid.renderOrder = 2;
  }

  addTo(scene: THREE.Scene) {
    scene.add(this.dots);
    scene.add(this.liquid);
  }

  setPixelRatio(dpr: number) {
    this.dotMat.uniforms.uDpr.value = dpr;
  }

  /** 换模板：清空在飞的粒子，按新物质配好材质。 */
  applySubstance(s: Substance) {
    this.clear();
    this.liqMat.uniforms.uCol.value.setRGB(s.color[0], s.color[1], s.color[2]);
    // 棕色液体不该反出白高光
    this.liqMat.uniforms.uGloss.value = s.color[0] < 0.5 ? 0.28 : 0.85;
    /*
     * 混合方式由物质自己声明，不再从 settle 推。
     *
     * 以前是 `settle ? Additive : Normal`，等于把「会不会堆积」和「用什么混合」
     * 绑在一个字段上，而它们是两件事：金粉要发光也要堆积，雪要堆积但不能发光
     * —— 白色加法叠在白墙、窗边、浅色沙发上完全看不见，
     * 在深色背景上调得很漂亮，到用户家里就没了。
     */
    this.dotMat.blending = s.blend === "add" ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.dotMat.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.dotAlp.fill(0);
    this.dotSiz.fill(0);
    this.liqRad.fill(0);
    this.liqAlp.fill(0);
    this.acc = 0;
    // 立刻刷新 GPU buffer，否则上一个模板的粒子还会画一帧
    this.dotGeo.attributes.palpha.needsUpdate = true;
    this.dotGeo.attributes.psize.needsUpdate = true;
    for (const k in this.liqAttr) this.liqAttr[k].needsUpdate = true;
  }

  hide() {
    this.dots.visible = false;
    this.liquid.visible = false;
  }

  show() {
    this.dots.visible = true;
    this.liquid.visible = true;
  }

  private alloc(): number {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    return i;
  }

  /**
   * 按速率发射。emitter 的位置由调用方给（世界坐标），
   * 因为道具可以被拖动，位置不属于粒子系统的状态。
   */
  emit(dt: number, rate: number, e: Emitter, s: Substance, propW: number, propH: number, ox: number, oy: number) {
    this.acc += rate * dt;
    const n = Math.min(this.acc | 0, 400); // 单帧上限，掉帧时不要雪崩
    this.acc -= n;
    for (let k = 0; k < n; k++) {
      const i = this.alloc();
      // 深度先定，size / speed / alpha 三处都按它缩放，层次感就出来了
      const z = Math.random();
      this.depth[i] = z;
      this.px[i] = ox + (Math.random() - 0.5) * e.band * propW;
      this.py[i] = oy + (Math.random() - 0.5) * 8;
      const sp = (s.speed[0] + Math.random() * (s.speed[1] - s.speed[0])) * lerp(0.7, 1.3, z);
      const ang = (e.tilt ?? 0) + (Math.random() - 0.5) * s.spread;
      this.vx[i] = Math.sin(ang) * sp;
      this.vy[i] = -Math.cos(ang) * sp;
      this.siz[i] = (s.size[0] + Math.random() * (s.size[1] - s.size[0])) * lerp(0.5, 1.6, z);
      this.streak[i] = s.streak;
      this.phase[i] = Math.random() * 7;
      this.freq[i] = 4 + Math.random() * 6;
      this.life[i] = 9;
      this.settled[i] = 0;
      this.isSplash[i] = 0;
    }
  }

  /** z 从撞上来的那一颗继承：溅起的水花跟母体在同一个深度层上。 */
  private splash(x: number, y: number, nx: number, ny: number, s: Substance, z: number) {
    for (let k = 0; k < s.splash; k++) {
      const i = this.alloc();
      this.depth[i] = z;
      this.freq[i] = 4 + Math.random() * 6;
      const a = Math.atan2(ny, nx) + (Math.random() - 0.5) * 1.5;
      const sp = 80 + Math.random() * 220;
      this.px[i] = x;
      this.py[i] = y;
      this.vx[i] = Math.cos(a) * sp;
      this.vy[i] = Math.sin(a) * sp + 60;
      this.siz[i] = 1.6 + Math.random() * 2.2;
      this.streak[i] = 0;
      this.phase[i] = 0;
      this.life[i] = 0.35 + Math.random() * 0.3;
      this.settled[i] = 0;
      this.isSplash[i] = 1;
    }
  }

  /**
   * 积分一帧。
   * 碰撞：占据场 > 0.5 → 取负梯度当表面法线 → 消掉法向速度、只留切向。
   * 剩下的重力自己会做：头顶接近水平，切向分量几乎为零，雪就堆住；
   * 肩膀和脸颊是斜的，切向分量大，就顺着往下溜。不需要写「沿轮廓走」的逻辑。
   */
  step(dt: number, t: number, field: OccupancyField, s: Substance, wind: number, stick: number, W: number, H: number) {
    const fric = Math.min(0.98, s.friction * stick);
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        this.dotAlp[i] = 0;
        this.dotSiz[i] = 0;
        this.liqRad[i] = 0;
        this.liqAlp[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.dotAlp[i] = 0;
        this.dotSiz[i] = 0;
        this.liqRad[i] = 0;
        this.liqAlp[i] = 0;
        continue;
      }

      this.vy[i] += s.gravity * dt;
      this.vx[i] += (wind - this.vx[i]) * 0.6 * dt;
      let nx_ = this.px[i] + this.vx[i] * dt;
      let ny_ = this.py[i] + this.vy[i] * dt;

      if (field.seen && !this.isSplash[i] && field.at(nx_, ny_) > 0.5) {
        let nx = field.at(nx_ - NORMAL_EPS, ny_) - field.at(nx_ + NORMAL_EPS, ny_);
        let ny = field.at(nx_, ny_ - NORMAL_EPS) - field.at(nx_, ny_ + NORMAL_EPS);
        const L = Math.hypot(nx, ny);
        if (L < 1e-4) {
          nx = 0;
          ny = 1;
        } else {
          nx /= L;
          ny /= L;
        }
        nx_ += nx * 5; // 推出体外
        ny_ += ny * 5;
        const impact = Math.hypot(this.vx[i], this.vy[i]);
        const vn = this.vx[i] * nx + this.vy[i] * ny;
        this.vx[i] -= vn * nx;
        this.vy[i] -= vn * ny;
        // 碰撞后大幅减速：摩擦 + 额外衰减
        const dampFactor = Math.max(0.02, 1 - fric);
        this.vx[i] *= dampFactor * 0.6;
        this.vy[i] *= dampFactor * 0.6;
        if (!this.settled[i]) {
          this.settled[i] = 1;
          if (s.settle) {
            this.life[i] = Math.min(this.life[i], 1.4 + Math.random() * 1.6);
          } else {
            // 液体碰到人体后缩短生命，不让它滑太远
            this.life[i] = Math.min(this.life[i], 1.0 + Math.random() * 1.0);
          }
          if (s.splash && impact > 260) this.splash(nx_, ny_, nx, ny, s, this.depth[i]);
        }
      }

      this.px[i] = nx_;
      this.py[i] = ny_;
      if (ny_ < -H / 2 - 30 || Math.abs(nx_) > W) {
        this.life[i] = 0;
        continue;
      }

      const fade = Math.min(1, this.life[i] / (this.settled[i] && s.settle ? 1.2 : 0.9));
      // 远处的粒子淡一点，和 size / speed 一起构成深度层次
      const depth = lerp(0.55, 1.0, this.depth[i]);
      const a = (s.twinkle ? fade * (0.55 + 0.45 * Math.sin(t * this.freq[i] + this.phase[i])) : fade) * depth;

      if (this.streak[i] > 0 && !this.isSplash[i]) {
        this.dotSiz[i] = 0;
        this.dotAlp[i] = 0;
        const sp = Math.hypot(this.vx[i], this.vy[i]);
        this.liqPos[i * 2] = nx_;
        this.liqPos[i * 2 + 1] = ny_;
        if (sp > 1) {
          this.liqDir[i * 2] = this.vx[i] / sp;
          this.liqDir[i * 2 + 1] = this.vy[i] / sp;
        } else {
          this.liqDir[i * 2] = 1;
          this.liqDir[i * 2 + 1] = 0;
        }
        this.liqLen[i] = Math.min(sp * this.streak[i], 70) * 0.5; // 半长；停下来自然收成圆水珠
        this.liqRad[i] = this.siz[i];
        this.liqAlp[i] = a;
      } else {
        this.dotPos[i * 3] = nx_;
        this.dotPos[i * 3 + 1] = ny_;
        this.dotCol[i * 3] = s.color[0];
        this.dotCol[i * 3 + 1] = s.color[1];
        this.dotCol[i * 3 + 2] = s.color[2];
        this.dotSiz[i] = this.siz[i];
        this.dotAlp[i] = a;
        this.liqRad[i] = 0;
        this.liqAlp[i] = 0;
      }
    }

    this.dotGeo.attributes.position.needsUpdate = true;
    this.dotGeo.attributes.pcolor.needsUpdate = true;
    this.dotGeo.attributes.psize.needsUpdate = true;
    this.dotGeo.attributes.palpha.needsUpdate = true;
    for (const k in this.liqAttr) this.liqAttr[k].needsUpdate = true;
  }

  dispose() {
    this.dotGeo.dispose();
    this.dotMat.dispose();
    this.liquid.geometry.dispose();
    this.liqMat.dispose();
  }
}
