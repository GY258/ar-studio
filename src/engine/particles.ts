import * as THREE from "three";
import type { OccupancyField } from "./occupancy";
import type { Emitter, Substance } from "./types";
import { ATLAS_GRID, spriteAtlas, spriteDefs } from "./sprites";

/**
 * 粒子池：固定容量循环复用，不在循环内分配对象（PRD 5.2）。
 *
 * 一套数据三种渲染：
 *  - 圆点（雪、溅起的水珠）走 Points
 *  - 液体走沿速度方向拉伸的 instanced 胶囊
 *  - 贴图（糖果）走带旋转的 instanced 方片，从图集里取格子
 *
 * 为什么不用 LineSegments 画液体：WebGL 里 gl.lineWidth 在 Chrome/ANGLE 上恒等于 1
 * 设备像素，2x 屏上就是半个 CSS 像素的头发丝，改任何参数都救不回来。
 */

const MAX = 9000;
const NORMAL_EPS = 10; // 求表面法线的差分步长，世界像素

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 速度、重力、风的单位换算。
 *
 * 雪和水的这几个数是像素/秒，换个屏幕大小落点就漂 —— 对它们无所谓，满屏都在下。
 * 贴图物质（糖果）要从杯口**落到头顶上**，落点漂了效果就没了，所以按短边 1000px 归一。
 */
function physicsUnit(s: Substance, W: number, H: number): number {
  return s.sprites ? Math.min(W, H) / 1000 : 1;
}

/** 碰撞判定阈值。贴图有个头，用低一点的阈值让它在轮廓外面一点就弹开，不至于半颗陷进头发里 */
const HIT = 0.5;
const HIT_SPRITE = 0.3;
const SEED = 0x9e3779b9;

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
   * 随机数走 this.rnd（播种的），clear() 时重置种子 —— 粒子现在也在离线 harness 里跑，
   * 「同一份输入渲染多少次都是同一张图」要成立。
   */
  private readonly depth = new Float32Array(MAX);
  private readonly streak = new Float32Array(MAX);
  private readonly settled = new Uint8Array(MAX);
  private readonly isSplash = new Uint8Array(MAX);
  private readonly rot = new Float32Array(MAX);
  private readonly omega = new Float32Array(MAX);
  private readonly cell = new Uint8Array(MAX);
  private cursor = 0;
  private acc = 0;
  private seed = SEED;

  /** mulberry32。不用 Math.random：离线渲染要逐位可复现 */
  private rnd(): number {
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 当前物质的贴图：每格的累积权重和相对大小。null = 不是贴图物质 */
  private spriteCdf: Float32Array | null = null;
  private spriteScale: Float32Array | null = null;
  private atlasTex: THREE.CanvasTexture | null = null;
  private atlasSet = "";

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

  // 贴图方片
  private readonly sprPos = new Float32Array(MAX * 2);
  private readonly sprRot = new Float32Array(MAX);
  private readonly sprSiz = new Float32Array(MAX);
  private readonly sprCell = new Float32Array(MAX);
  private readonly sprAlp = new Float32Array(MAX);
  private readonly sprAttr: Record<string, THREE.InstancedBufferAttribute> = {};
  private readonly sprMat: THREE.ShaderMaterial;
  readonly sprites: THREE.Mesh;

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

    const sprGeo = new THREE.InstancedBufferGeometry();
    sprGeo.index = quad.index;
    sprGeo.attributes.position = quad.attributes.position;
    sprGeo.attributes.uv = quad.attributes.uv;
    const sprSpec: [string, Float32Array, number][] = [
      ["iPos", this.sprPos, 2],
      ["iRot", this.sprRot, 1],
      ["iSiz", this.sprSiz, 1],
      ["iCell", this.sprCell, 1],
      ["iAlp", this.sprAlp, 1],
    ];
    for (const [name, arr, n] of sprSpec) {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      sprGeo.setAttribute(name, a);
      this.sprAttr[name] = a;
    }
    sprGeo.instanceCount = MAX;
    /*
     * 输出不做色彩空间转换：图集是 canvas 画的 sRGB 值，原样写出去。
     * 背景走的是 MeshBasicMaterial + SRGB 贴图，解码再编码一来一回也等于原值，两边一致。
     */
    this.sprMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      uniforms: { uAtlas: { value: null }, uGrid: { value: ATLAS_GRID } },
      vertexShader: `
        uniform float uGrid;
        attribute vec2 iPos; attribute float iRot; attribute float iSiz;
        attribute float iCell; attribute float iAlp;
        varying vec2 vUv; varying float vA;
        void main(){
          vA = iAlp;
          float c = cos(iRot), s = sin(iRot);
          vec2 p = position.xy * iSiz;
          vec2 w = iPos + vec2(c * p.x - s * p.y, s * p.x + c * p.y);
          // 图集第 0 格在左上，uv 的 y 朝上，所以行号要倒过来
          vec2 cell = vec2(mod(iCell, uGrid), uGrid - 1.0 - floor(iCell / uGrid));
          vUv = (cell + uv) / uGrid;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 0.0, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uAtlas;
        varying vec2 vUv; varying float vA;
        void main(){
          if (vA < 0.004) discard;
          vec4 c = texture2D(uAtlas, vUv);
          if (c.a < 0.01) discard;
          gl_FragColor = vec4(c.rgb, c.a * vA);
        }`,
    });
    this.sprites = new THREE.Mesh(sprGeo, this.sprMat);
    this.sprites.frustumCulled = false;
    this.sprites.renderOrder = 2;
    this.sprites.visible = false;
  }

  addTo(scene: THREE.Scene) {
    scene.add(this.dots);
    scene.add(this.liquid);
    scene.add(this.sprites);
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

    if (s.sprites) {
      const defs = spriteDefs(s.sprites.set);
      let acc = 0;
      const total = defs.reduce((a, d) => a + d.weight, 0);
      this.spriteCdf = new Float32Array(defs.map((d) => (acc += d.weight / total)));
      this.spriteScale = new Float32Array(defs.map((d) => d.scale));
      if (this.atlasSet !== s.sprites.set) {
        this.atlasTex?.dispose();
        this.atlasTex = new THREE.CanvasTexture(spriteAtlas(s.sprites.set));
        // 默认 flipY，第 0 格在纹理坐标的左上 —— 着色器里倒行号就是为了这个
        this.atlasTex.anisotropy = 4;
        this.atlasSet = s.sprites.set;
      }
      this.sprMat.uniforms.uAtlas.value = this.atlasTex;
    } else {
      this.spriteCdf = null;
      this.spriteScale = null;
    }
    this.sprites.visible = this.dots.visible && !!this.spriteCdf;
  }

  clear() {
    this.life.fill(0);
    this.dotAlp.fill(0);
    this.dotSiz.fill(0);
    this.liqRad.fill(0);
    this.liqAlp.fill(0);
    this.sprAlp.fill(0);
    this.sprSiz.fill(0);
    this.acc = 0;
    this.seed = SEED;
    // 立刻刷新 GPU buffer，否则上一个模板的粒子还会画一帧
    this.dotGeo.attributes.palpha.needsUpdate = true;
    this.dotGeo.attributes.psize.needsUpdate = true;
    for (const k in this.liqAttr) this.liqAttr[k].needsUpdate = true;
    for (const k in this.sprAttr) this.sprAttr[k].needsUpdate = true;
  }

  hide() {
    this.dots.visible = false;
    this.liquid.visible = false;
    this.sprites.visible = false;
  }

  show() {
    this.dots.visible = true;
    this.liquid.visible = true;
    this.sprites.visible = !!this.spriteCdf;
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
  emit(
    dt: number,
    rate: number,
    e: Emitter,
    s: Substance,
    propW: number,
    propH: number,
    ox: number,
    oy: number,
    W: number,
    H: number,
  ) {
    const unit = physicsUnit(s, W, H);
    this.acc += rate * dt;
    const n = Math.min(this.acc | 0, 400); // 单帧上限，掉帧时不要雪崩
    this.acc -= n;
    for (let k = 0; k < n; k++) {
      const i = this.alloc();
      // 深度先定，size / speed / alpha 三处都按它缩放，层次感就出来了
      const z = this.rnd();
      this.depth[i] = z;
      this.px[i] = ox + (this.rnd() - 0.5) * e.band * propW;
      this.py[i] = oy + (this.rnd() - 0.5) * 8;
      const sp = (s.speed[0] + this.rnd() * (s.speed[1] - s.speed[0])) * lerp(0.7, 1.3, z) * unit;
      const ang = (e.tilt ?? 0) + (this.rnd() - 0.5) * s.spread;
      this.vx[i] = Math.sin(ang) * sp;
      this.vy[i] = -Math.cos(ang) * sp;
      this.siz[i] = (s.size[0] + this.rnd() * (s.size[1] - s.size[0])) * lerp(0.5, 1.6, z);
      if (this.spriteCdf && s.sprites) {
        const r = this.rnd();
        let c = 0;
        while (c < this.spriteCdf.length - 1 && r > this.spriteCdf[c]) c++;
        this.cell[i] = c;
        // 贴图的 siz 是**整颗的宽度**，单位是画面短边的比例，step 里再乘短边
        const [a, b] = s.sprites.size;
        this.siz[i] = (a + this.rnd() * (b - a)) * this.spriteScale![c] * lerp(0.85, 1.15, z);
        this.rot[i] = this.rnd() * Math.PI * 2;
        this.omega[i] = (this.rnd() * 2 - 1) * s.sprites.spin;
      }
      this.streak[i] = s.streak;
      this.phase[i] = this.rnd() * 7;
      this.freq[i] = 4 + this.rnd() * 6;
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
      this.freq[i] = 4 + this.rnd() * 6;
      const a = Math.atan2(ny, nx) + (this.rnd() - 0.5) * 1.5;
      const sp = 80 + this.rnd() * 220;
      this.px[i] = x;
      this.py[i] = y;
      this.vx[i] = Math.cos(a) * sp;
      this.vy[i] = Math.sin(a) * sp + 60;
      this.siz[i] = 1.6 + this.rnd() * 2.2;
      this.streak[i] = 0;
      this.phase[i] = 0;
      this.life[i] = 0.35 + this.rnd() * 0.3;
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
    const sprite = !!this.spriteCdf;
    const short = Math.min(W, H);
    const hit = sprite ? HIT_SPRITE : HIT;
    const bounce = s.bounce ?? 0;
    const unit = physicsUnit(s, W, H);
    const gravity = s.gravity * unit;
    wind *= unit;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        this.hideOne(i);
        continue;
      }
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.hideOne(i);
        continue;
      }

      this.vy[i] += gravity * dt;
      this.vx[i] += (wind - this.vx[i]) * 0.6 * dt;
      let nx_ = this.px[i] + this.vx[i] * dt;
      let ny_ = this.py[i] + this.vy[i] * dt;

      if (field.seen && !this.isSplash[i] && field.at(nx_, ny_) > hit) {
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
        if (sprite) {
          /*
           * 硬东西：法向反弹、切向只吃一点摩擦。
           * 只在「正往里钻」（vn < 0）时反弹 —— 已经在往外走的再反一次会被弹回体内，
           * 表现是糖果贴着头皮来回抖。
           */
          if (vn < 0) {
            this.vx[i] -= (1 + bounce) * vn * nx;
            this.vy[i] -= (1 + bounce) * vn * ny;
            /*
             * 往两边拨一下。头顶几乎是平的，只靠重力的切向分量糖果会停在头顶堆成一坨 ——
             * 参考里是「碰到头顶弹开、从两侧落下」。拨的方向跟着坡（左坡往左、右坡往右），
             * 正顶上随机选一边；力度乘 ny，所以只在朝上的面上拨，侧面不额外加速。
             */
            if (ny > 0) {
              const side = Math.abs(nx) > 0.12 ? Math.sign(nx) : this.rnd() < 0.5 ? -1 : 1;
              this.vx[i] += side * -vn * (0.35 + this.rnd() * 0.35) * ny;
            }
          }
          const keep = 1 - fric * 0.5;
          const vt = this.vx[i] * -ny + this.vy[i] * nx;
          this.vx[i] -= vt * (1 - keep) * -ny;
          this.vy[i] -= vt * (1 - keep) * nx;
          // 擦着表面滚过去会带出自转：切向速度越大转得越快，方向跟着滚的方向
          this.omega[i] = this.omega[i] * 0.5 + (vt / Math.max(4, this.siz[i] * short * 0.5)) * 0.5;
          // 卡住了（两个头之间的凹处、平肩膀上）就淡掉，不然那里会越堆越高
          if (Math.hypot(this.vx[i], this.vy[i]) < 60 * unit) this.life[i] = Math.min(this.life[i], 0.6);
        } else {
          this.vx[i] -= vn * nx;
          this.vy[i] -= vn * ny;
          // 碰撞后大幅减速：摩擦 + 额外衰减
          const dampFactor = Math.max(0.02, 1 - fric);
          this.vx[i] *= dampFactor * 0.6;
          this.vy[i] *= dampFactor * 0.6;
        }
        if (!this.settled[i]) {
          this.settled[i] = 1;
          if (sprite) {
            // 弹开之后还要飞一段、顺着肩膀滑下去，不能像液体那样很快收掉
            this.life[i] = Math.min(this.life[i], 3 + this.rnd() * 2);
          } else if (s.settle) {
            this.life[i] = Math.min(this.life[i], 1.4 + this.rnd() * 1.6);
          } else {
            // 液体碰到人体后缩短生命，不让它滑太远
            this.life[i] = Math.min(this.life[i], 1.0 + this.rnd() * 1.0);
          }
          if (s.splash && impact > 260) this.splash(nx_, ny_, nx, ny, s, this.depth[i]);
        }
      }

      this.px[i] = nx_;
      this.py[i] = ny_;
      if (ny_ < -H / 2 - 30 - (sprite ? this.siz[i] * short : 0) || Math.abs(nx_) > W) {
        this.life[i] = 0;
        this.hideOne(i);
        continue;
      }

      if (sprite && !this.isSplash[i]) {
        this.rot[i] += this.omega[i] * dt;
        this.dotSiz[i] = 0;
        this.dotAlp[i] = 0;
        this.liqRad[i] = 0;
        this.liqAlp[i] = 0;
        this.sprPos[i * 2] = nx_;
        this.sprPos[i * 2 + 1] = ny_;
        this.sprRot[i] = this.rot[i];
        this.sprSiz[i] = this.siz[i] * short;
        this.sprCell[i] = this.cell[i];
        // 贴图不按深度变淡：实心的卡通糖果半透明了像鬼影
        this.sprAlp[i] = Math.min(1, this.life[i] / 0.5);
        continue;
      }
      this.sprAlp[i] = 0;
      this.sprSiz[i] = 0;

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
    if (sprite) for (const k in this.sprAttr) this.sprAttr[k].needsUpdate = true;
  }

  private hideOne(i: number) {
    this.dotAlp[i] = 0;
    this.dotSiz[i] = 0;
    this.liqRad[i] = 0;
    this.liqAlp[i] = 0;
    this.sprAlp[i] = 0;
    this.sprSiz[i] = 0;
  }

  dispose() {
    this.dotGeo.dispose();
    this.dotMat.dispose();
    this.liquid.geometry.dispose();
    this.liqMat.dispose();
    this.sprites.geometry.dispose();
    this.sprMat.dispose();
    this.atlasTex?.dispose();
  }
}
