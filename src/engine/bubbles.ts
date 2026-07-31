/**
 * 肥皂泡：从画面下方缓缓飘起，指尖划过去戳破。
 *
 * ## 状态是怎么被压到最小的
 *
 * ROADMAP 里把这一块标成「唯一有设计风险的部分」，理由是「泡泡是可变、
 * 互相作用的状态」——会飘、会撞、会破，而 `renderAt(t)` 要求可回放。
 * 真做下来发现风险小得多，因为**位置可以写成闭式**：
 *
 *   y(t) = y0 + vy * (t - t0)
 *   x(t) = x0 + sin(t * WOBBLE_HZ + phase) * wobble
 *
 * 一个泡泡从生到死只需要存 `{ t0, x0, r, vy, phase }` 这几个**不变量**，
 * 每帧不修改任何东西。不做逐帧积分就没有「浮点求和顺序敏感」这个问题，
 * 也不会因为掉帧而漂。
 *
 * 于是真正可变的只剩一件事：**破没破**。它由外部输入（指尖）触发、不可逆，
 * 是个单调的状态位 —— 和轨迹的 append-only 是同一个量级的复杂度，
 * 不是原先担心的那种「一池互相影响的对象」。
 *
 * ## 没做泡泡之间的碰撞
 *
 * 参考素材里泡泡是互相穿过、堆叠着的，没有弹开。真做碰撞要放弃闭式位置、
 * 回到逐帧积分，把上面那一整段简单性都赔进去 —— 换来的是一个在参考里
 * 根本看不出来的效果。要做也该等到它真的成为观感瓶颈。
 *
 * ## 冒泡时刻落在固定时间网格上
 *
 * 和轨迹采样同一条纪律：按「每帧掷一次骰子」冒泡的话，60fps 和 20fps
 * 会冒出完全不同的数量，离线 golden 和线上不一致，换台机器就变。
 */

import * as THREE from "three";

/** 每秒最多冒几个。落在固定网格上，见文件头 */
const SPAWN_RATE = 5;
/** 破掉之后的残留动画时长，秒 */
const POP_SECONDS = 0.26;
/** 横向摆动频率，Hz。慢到像空气流动，不像抖动 */
const WOBBLE_HZ = 0.21;

/** 确定性 hash。冒泡的位置、大小、速度全走它，不许出现真随机数 */
function hash1(i: number, seed: number): number {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export interface BubbleParams {
  /** 同时最多几个 */
  count: number;
  /** 上升速度，每秒走过画面高度的比例 */
  rise: number;
  /** 半径范围，占画面宽度的比例 */
  size: [number, number];
  /** 横向摆动幅度，占画面宽度的比例 */
  wobble: number;
  /** 戳破判定半径，相对泡泡半径的倍数。>1 是因为指尖 landmark 本身有抖动 */
  popRadius: number;
  /** 折射强度：泡泡把背后的画面推开多少，相对自身半径 */
  refraction: number;
  /** 边缘薄膜干涉的彩虹强度 0~1 */
  iridescence: number;
  opacity: number;
  seed: number;
}

/** 一个泡泡。除了 poppedAt，其余都是生成时定死的不变量 */
interface Bubble {
  /** 出生时刻，秒 */
  t0: number;
  /** 出生时的横向位置，世界坐标 */
  x0: number;
  /** 半径，px */
  r: number;
  /** 上升速度，px/s */
  vy: number;
  /** 摆动相位 */
  phase: number;
  /** 每个泡泡自己的随机种子，决定高光位置和彩虹相位 */
  seed: number;
  /** 破掉的时刻。null = 还活着 */
  poppedAt: number | null;
}

export class BubbleField {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly attrs: Record<string, THREE.InstancedBufferAttribute> = {};
  private readonly iPos: Float32Array;
  private readonly iRad: Float32Array;
  private readonly iAlp: Float32Array;
  private readonly iSeed: Float32Array;
  private readonly iPop: Float32Array;

  private bubbles: Bubble[] = [];
  /** 上一次冒泡落在哪个网格格子。-1 = 还没冒过 */
  private lastSlot = -1;
  private lastT = -1;
  private W = 1280;
  private H = 720;

  constructor(
    private readonly params: BubbleParams,
    private readonly max: number,
  ) {
    this.iPos = new Float32Array(max * 2);
    this.iRad = new Float32Array(max);
    this.iAlp = new Float32Array(max);
    this.iSeed = new Float32Array(max);
    this.iPop = new Float32Array(max);

    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.attributes.position = quad.attributes.position;
    const spec: [string, Float32Array, number][] = [
      ["iPos", this.iPos, 2],
      ["iRad", this.iRad, 1],
      ["iAlp", this.iAlp, 1],
      ["iSeed", this.iSeed, 1],
      ["iPop", this.iPop, 1],
    ];
    for (const [name, arr, n] of spec) {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, a);
      this.attrs[name] = a;
    }
    this.geo.instanceCount = max;

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      /*
       * depthTest 关掉，靠**绘制顺序**决定谁压谁。
       *
       * ROADMAP 里担心「18 个大泡泡叠在一起会露馅」。真正会露馅的是
       * 半透明物体的混合顺序，而深度测试对半透明没用（写不写深度都不对）。
       * 正确做法是每帧按 y 排序后再写实例缓冲，见 update() 里的注释。
       */
      depthTest: false,
      uniforms: {
        uSrc: { value: null },
        uRes: { value: new THREE.Vector2(1280, 720) },
        uRefract: { value: params.refraction },
        uIrid: { value: params.iridescence },
        uOpacity: { value: params.opacity },
      },
      vertexShader: `
        attribute vec2 iPos;
        attribute float iRad;
        attribute float iAlp;
        attribute float iSeed;
        attribute float iPop;
        varying float vA; varying float vSeed; varying float vPop; varying float vRad;
        varying vec2 vLocal;
        void main(){
          vA = iAlp; vSeed = iSeed; vPop = iPop; vRad = iRad;
          // 破掉的瞬间整体涨一点，读起来才像「炸开」而不是「消失」
          float grow = 1.0 + iPop * 0.35;
          vLocal = position.xy * 2.0;
          vec2 w = iPos + position.xy * 2.0 * iRad * grow;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 0.0, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uSrc;
        uniform vec2 uRes;
        uniform float uRefract;
        uniform float uIrid;
        uniform float uOpacity;
        varying float vA; varying float vSeed; varying float vPop; varying float vRad;
        varying vec2 vLocal;

        /** 波长 → 近似 RGB。薄膜干涉的彩虹用它，比直接查 HSV 表更像真实色散 */
        vec3 spectrum(float t){
          return clamp(vec3(
            abs(t * 6.0 - 3.0) - 1.0,
            2.0 - abs(t * 6.0 - 2.0),
            2.0 - abs(t * 6.0 - 4.0)
          ), 0.0, 1.0);
        }

        void main(){
          float d = length(vLocal);
          if (d > 1.0 || vA < 0.004) discard;

          /*
           * 球面法线。z 是从 d 反推的 —— 这是把一个平面 quad 当成球来着色的
           * 标准做法，也是折射和边缘发亮的来源。
           */
          float z = sqrt(max(0.0, 1.0 - d * d));
          vec3 n = vec3(vLocal, z);

          /*
           * 折射：直接采源视频纹理，把背后的画面往外推。
           *
           * 不需要读回帧缓冲 —— 泡泡背后就是摄像头画面，而那正是想要的效果。
           * 屏幕 uv 的 x 要翻过来：背景平面是 scale.x = -1 的镜像，
           * 这里必须守同一个约定，不然泡泡里的画面是反的（这个坑在这个仓库里
           * 已经踩过两次了）。
           */
          vec2 screen = gl_FragCoord.xy / uRes;
          vec2 srcUv = vec2(1.0 - screen.x, screen.y);
          vec2 off = n.xy * uRefract * (vRad / uRes.y) * 2.0;
          vec3 behind = texture2D(uSrc, clamp(srcUv + off, 0.001, 0.999)).rgb;

          /*
           * 边缘分两层：一圈很窄的亮边 + 一层很宽很淡的膜。
           *
           * 只做一层的话得到的是「一个彩色圆环」，参考素材里的泡泡是
           * **亮白软边**，中间还蒙着一层极淡的光 —— 那层宽的膜才是
           * 「这是一层液膜」的读法，缺了它就只是描边。
           */
          float rim = pow(1.0 - z, 3.2);
          float film = pow(1.0 - z, 1.2) * 0.32;

          /*
           * 薄膜干涉只出现在**最外那一圈**（6 次幂），不是铺满整个球。
           *
           * 铺满会得到一个饱和的彩虹圆环，一眼假：真实肥皂泡的色散集中在
           * 掠射角，正面看几乎是无色的。相位随边缘距离和每个泡泡自己的 seed 走 ——
           * 所有泡泡彩虹一模一样的话，同样一眼就看出是贴图不是物理。
           */
          vec3 irid = spectrum(fract(d * 2.2 + vSeed * 3.7)) * pow(1.0 - z, 6.0) * uIrid;

          // 两点高光。位置也跟 seed 走，不然满屏泡泡的高光排成一列
          float a1 = vSeed * 6.28318;
          vec2 h1 = vec2(cos(a1), sin(a1)) * 0.45;
          vec2 h2 = h1 * -0.55 + vec2(0.12, -0.1);
          float spec = 0.0;
          spec += smoothstep(0.20, 0.0, length(vLocal - h1));
          spec += smoothstep(0.13, 0.0, length(vLocal - h2)) * 0.7;

          // 膜会透一点光，所以泡泡内部比背景**略亮**。差别很小，但少了它泡泡会显脏
          vec3 col = behind * 1.06 + 0.02 + irid + vec3(spec) + vec3(rim * 0.55);

          /*
           * 泡膜本身几乎是透明的，只有边缘和高光看得见 ——
           * 中间给不透明度的话立刻变成塑料球。
           */
          float alpha = (0.05 + film + rim * 0.9 + spec) * vA * uOpacity;
          // 破掉的过程：环向外扩张同时整体淡出
          alpha *= 1.0 - vPop;
          alpha *= mix(1.0, smoothstep(0.55, 1.0, d), vPop);

          if (alpha < 0.004) discard;
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        }`,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6; // 压在贴纸之上：泡泡是最靠近镜头的东西
  }

  setViewport(w: number, h: number) {
    this.W = w;
    this.H = h;
    (this.mat.uniforms.uRes.value as THREE.Vector2).set(w, h);
  }

  /** 折射要采的画面。引擎换源（摄像头 ↔ 离线静态图）时要重新传 */
  setSource(tex: THREE.Texture | null) {
    this.mat.uniforms.uSrc.value = tex;
  }

  /** 清掉所有跨帧状态。切模板和时间倒流时调 */
  reset() {
    this.bubbles.length = 0;
    this.lastSlot = -1;
    this.lastT = -1;
  }

  /** 当前活着的泡泡数。测试用来断言「真的在冒」和「真的被戳破了」 */
  aliveCount(): number {
    return this.bubbles.filter((b) => b.poppedAt === null).length;
  }

  /**
   * 推进到时刻 t。tips 是这一帧所有指尖的世界坐标。
   *
   * 只有「破没破」是真的在改状态；位置是 t 的闭式函数，见文件头。
   */
  update(t: number, tips: readonly { x: number; y: number }[]) {
    // 时间倒流：整个重来。状态是历史的函数，倒着走没有意义（同 TrailBuffer）
    if (t < this.lastT) this.reset();
    this.lastT = t;

    const p = this.params;
    const top = this.H / 2;
    const bottom = -this.H / 2;

    // --- 冒泡。落在固定时间网格上，不是每帧掷骰子 ---
    const slot = Math.floor(t * SPAWN_RATE);
    if (this.lastSlot < 0) this.lastSlot = slot - 1;
    for (let s = this.lastSlot + 1; s <= slot; s++) {
      if (this.bubbles.length >= this.max) break;
      if (this.aliveCount() >= p.count) continue;
      const h = (k: number) => hash1(s * 7 + k, p.seed);
      const r = (p.size[0] + (p.size[1] - p.size[0]) * h(1)) * this.W;
      this.bubbles.push({
        t0: s / SPAWN_RATE,
        // 留出半径的余量，免得整排泡泡贴着画面边缘冒出来
        x0: (h(2) - 0.5) * (this.W - r * 2),
        r,
        // 大泡泡升得慢一点。真实的肥皂泡阻力随半径涨，小的窜得快
        vy: p.rise * this.H * (0.75 + 0.5 * h(3)) * (1.0 - 0.35 * (r / (p.size[1] * this.W))),
        phase: h(4) * Math.PI * 2,
        seed: h(5),
        poppedAt: null,
      });
    }
    this.lastSlot = slot;

    // --- 位置（闭式）+ 戳破判定 + 回收 ---
    const live: Bubble[] = [];
    for (const b of this.bubbles) {
      const age = t - b.t0;
      const y = bottom - b.r + b.vy * age;
      const x = b.x0 + Math.sin(t * WOBBLE_HZ * Math.PI * 2 + b.phase) * p.wobble * this.W;

      if (b.poppedAt === null) {
        // 飘出画面顶端就回收
        if (y - b.r > top) continue;
        const pr = b.r * p.popRadius;
        for (const tip of tips) {
          if (Math.hypot(tip.x - x, tip.y - y) < pr) {
            b.poppedAt = t;
            break;
          }
        }
      } else if (t - b.poppedAt > POP_SECONDS) {
        continue;
      }
      live.push(b);
    }
    this.bubbles = live;

    // --- 写实例缓冲 ---
    /*
     * 先按 y 从远到近排序再写。
     *
     * 半透明物体的正确合成依赖绘制顺序，而深度测试对它没用。
     * 不排的话混合顺序就是「谁先冒出来谁先画」，两个泡泡叠在一起时
     * 前后关系会跟着回收顺序随机变 —— 而且同一个 t 排两次得到的顺序
     * 必须一样，所以排序键里带上 t0 打破平局，不能只按 y。
     */
    const sorted = this.bubbles
      .map((b) => {
        const age = t - b.t0;
        return {
          b,
          x: b.x0 + Math.sin(t * WOBBLE_HZ * Math.PI * 2 + b.phase) * p.wobble * this.W,
          y: bottom - b.r + b.vy * age,
        };
      })
      .sort((a, c) => a.y - c.y || a.b.t0 - c.b.t0);

    let n = 0;
    for (const { b, x, y } of sorted) {
      if (n >= this.max) break;
      const pop = b.poppedAt === null ? 0 : Math.min(1, (t - b.poppedAt) / POP_SECONDS);
      // 刚冒出来时淡入，不然会在画面底边凭空出现
      const fadeIn = Math.min(1, (t - b.t0) * 2.2);
      this.iPos[n * 2] = x;
      this.iPos[n * 2 + 1] = y;
      this.iRad[n] = b.r;
      this.iAlp[n] = fadeIn;
      this.iSeed[n] = b.seed;
      this.iPop[n] = pop;
      n++;
    }
    for (let i = n; i < this.max; i++) this.iAlp[i] = 0;

    for (const k of Object.keys(this.attrs)) this.attrs[k].needsUpdate = true;
    this.geo.instanceCount = this.max;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
