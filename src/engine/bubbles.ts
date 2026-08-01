/**
 * 肥皂泡：满屏浮着，指尖划过去戳破。
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
 * ## 一开场就满屏，破了不再生 —— 所以能清空
 *
 * 泡泡不从画面底边冒出来，一开场屏幕上就是满的：固定 count 个槽位，位置纵向
 * **绕回**（飘出顶端就从底端接着进来），所以没人戳的话一个都不会少。
 *
 * 破掉的**不再生**。这让它有了终局：全部戳完屏幕就空了。
 * 会不停补充的话就只是个屏保，没有「玩完了」这件事。
 *
 * 于是可变状态只剩一个单调递减的集合 —— 比 append-only 还简单。
 */

import * as THREE from "three";

/** 破掉之后的残留动画时长，秒 */
const POP_SECONDS = 0.26;
/** 横向摆动频率，Hz。慢到像空气流动，不像抖动 */
const WOBBLE_HZ = 0.21;

/**
 * 确定性 hash。泡泡的位置、大小、速度全走它，不许出现真随机数。
 *
 * **不能用 `fract(sin(i * k) * big)` 那一套。** 这里的下标是等差的
 * （slot * 131 + gen * 17 + k），而 131 * 127.1 对 2π 取模只剩 0.1 弧度 ——
 * 相邻槽位算出来的值几乎相同，30 个泡泡会挤成一坨。
 * 这个坑很隐蔽：hash 本身「看起来是随机的」，只有在等差下标上才退化。
 *
 * 换成整数雪崩混合（xorshift + imul），对任何下标模式都均匀。
 */
function hash1(i: number, seed: number): number {
  let x = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x ^ Math.imul(seed | 0, 0xc2b2ae35), 0x27d4eb2f);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export interface BubbleParams {
  /** 同时最多几个 */
  count: number;
  /** 上浮速度，每秒走过画面高度的比例。飘出顶端会从底端绕回来 */
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
  /** 出生时刻，秒。全部是 0 —— 一开场就都在了 */
  t0: number;
  /** 出生时的横向位置，世界坐标 */
  x0: number;
  /** 出生时的纵向位置，世界坐标。绕回的起点 */
  y0: number;
  /** 半径，px */
  r: number;
  /** 上浮速度，px/s */
  vy: number;
  /** 摆动相位 */
  phase: number;
  /** 决定高光位置、彩虹相位和彩虹朝哪一侧 */
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
  /** 已经铺过一次了。和 bubbles.length 分开：全戳完之后长度是 0，但不该重铺 */
  private seeded = false;
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
        uMirror: { value: 1 },
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
        uniform float uMirror;
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
          // 前置摄像头画面是镜像的（背景平面 scale.x = -1），这里必须守同一个约定；
          // 后置不镜像。不跟着翻的话泡泡里的画面是反的
          vec2 srcUv = vec2(uMirror > 0.5 ? 1.0 - screen.x : screen.x, screen.y);
          vec2 off = n.xy * uRefract * (vRad / uRes.y) * 2.0;
          vec3 behind = texture2D(uSrc, clamp(srcUv + off, 0.001, 0.999)).rgb;

          /*
           * 边缘分两层：一圈很窄的亮边 + 一层很宽的膜。
           *
           * 只做一层的话得到的是「一个彩色圆环」，而参考素材里的泡泡
           * **明显是乳白色的实体**：能透出背后的画面，但整个球面都蒙着
           * 一层白，不是只有边缘亮。那层宽的膜才是「这是一层液膜」的读法。
           */
          float rim = pow(1.0 - z, 3.2);
          float film = pow(1.0 - z, 0.75);

          /*
           * 薄膜干涉是**一侧的月牙**，不是整圈。
           *
           * 铺满一圈得到的是彩虹环，一眼假。参考素材里色散只出现在每个泡泡的
           * 某一侧（光源方向那边），而且是一道弧 —— 这才是薄膜厚度沿球面变化
           * 该有的样子。方向随 seed 走，所以满屏泡泡的彩虹不会朝同一边。
           */
          float ang = vSeed * 6.28318;
          vec2 lightDir = vec2(cos(ang), sin(ang));
          float crescent = smoothstep(0.1, 0.95, dot(normalize(vLocal + 1e-5), lightDir));
          vec3 irid = spectrum(fract(d * 1.9 + vSeed * 3.7)) * pow(1.0 - z, 3.0) * crescent * uIrid;

          // 两点高光。位置也跟 seed 走，不然满屏泡泡的高光排成一列
          float a1 = vSeed * 6.28318;
          vec2 h1 = vec2(cos(a1), sin(a1)) * 0.45;
          vec2 h2 = h1 * -0.55 + vec2(0.12, -0.1);
          float spec = 0.0;
          spec += smoothstep(0.20, 0.0, length(vLocal - h1));
          spec += smoothstep(0.13, 0.0, length(vLocal - h2)) * 0.7;

          /*
           * 往乳白色混，而不是只把背景加亮。
           *
           * 只做 behind * 1.06 的话泡泡是「透明的、只有边亮」，参考素材里
           * 它们是**奶白色的球**：背后的画面还看得见，但明显蒙了一层白。
           * mix 到白色才有那个厚度感，单纯加亮只会让画面发灰。
           */
          vec3 milky = mix(behind, vec3(1.0), 0.26 + film * 0.24);
          vec3 col = milky + irid + vec3(spec) + vec3(rim * 0.5);

          // 整个球面都有不透明度（不只是边缘），但仍然透得过背景
          float alpha = (0.22 + film * 0.42 + rim * 0.5 + spec) * vA * uOpacity;
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

  /**
   * 滑块实时改一个参数。名单见 tunables.ts。
   *
   * 注意**不收 count 和 size**：泡泡的位置是出生时定死的不变量，
   * 中途改这两个只会作用在之后重生的那批上，而破了不再生 —— 于是拖滑块
   * 什么都不发生。这种「拖了没反应」正是要避免的，所以干脆不让它上滑块。
   */
  setParam(name: string, value: number) {
    if (name === "opacity") {
      this.mat.uniforms.uOpacity.value = value;
      return;
    }
    if (name === "refraction") this.mat.uniforms.uRefract.value = value;
    if (name === "iridescence") this.mat.uniforms.uIrid.value = value;
    (this.params as unknown as Record<string, number>)[name] = value;
  }

  setMirror(m: boolean) {
    this.mat.uniforms.uMirror.value = m ? 1 : 0;
  }

  /** 折射要采的画面。引擎换源（摄像头 ↔ 离线静态图）时要重新传 */
  setSource(tex: THREE.Texture | null) {
    this.mat.uniforms.uSrc.value = tex;
  }

  /** 清掉所有跨帧状态。切模板和时间倒流时调 */
  reset() {
    this.bubbles.length = 0;
    this.seeded = false;
    this.lastT = -1;
  }

  /** 当前活着的泡泡数。测试用来断言「真的在冒」和「真的被戳破了」 */
  aliveCount(): number {
    return this.bubbles.filter((b) => b.poppedAt === null).length;
  }

  /** 按槽位序号生成一个泡泡。全部走 hash，没有随机数 */
  private spawn(slot: number): Bubble {
    const p = this.params;
    const h = (k: number) => hash1(slot * 131 + k, p.seed);
    const r = (p.size[0] + (p.size[1] - p.size[0]) * h(1)) * this.W;

    /*
     * 分层撒点：每个槽位固定分到一个格子，只在格内抖动。
     *
     * 纯随机撒 30 个点必然结块 —— 第一版就是这样，一半屏幕空着，
     * 另一半挤成一坨。而「满屏浮着 30 个泡泡」要的是均匀铺开。
     * 分层是消除结块的标准做法，而且照样是 hash 的纯函数。
     *
     * 允许中心落在画面外一点（±0.55），让泡泡被画面边缘切开 ——
     * 全都完整地待在框里反而假，参考素材里边上的泡泡都是切掉一半的。
     */
    const cols = Math.max(1, Math.round(Math.sqrt((p.count * this.W) / this.H)));
    const rows = Math.max(1, Math.ceil(p.count / cols));
    const cx = (slot % cols) + 0.5;
    const cy = Math.floor(slot / cols) + 0.5;

    return {
      t0: 0,
      x0: ((cx + (h(2) - 0.5) * 0.9) / cols - 0.5) * this.W * 1.1,
      y0: ((cy + (h(6) - 0.5) * 0.9) / rows - 0.5) * this.H * 1.1,
      r,
      // 大泡泡升得慢一点。真实的肥皂泡阻力随半径涨，小的窜得快
      vy: p.rise * this.H * (0.75 + 0.5 * h(3)) * (1.0 - 0.35 * (r / (p.size[1] * this.W))),
      phase: h(4) * Math.PI * 2,
      seed: h(5),
      poppedAt: null,
    };
  }

  /** 这一代的当前位置。纵向绕回，所以是闭式的、数量恒定 */
  private posAt(b: Bubble, t: number): { x: number; y: number } {
    const p = this.params;
    const span = this.H + b.r * 2;
    // 绕回：飘出顶端就从底端接着进来。取模保证它是 t 的纯函数，不靠累加
    let y = b.y0 + b.vy * (t - b.t0) + this.H / 2 + b.r;
    y = ((y % span) + span) % span;
    return {
      x: b.x0 + Math.sin(t * WOBBLE_HZ * Math.PI * 2 + b.phase) * p.wobble * this.W,
      y: y - this.H / 2 - b.r,
    };
  }

  /**
   * 推进到时刻 t。tips 是这一帧所有指尖的世界坐标。
   *
   * 只有「破没破」和「第几代」是真的在改状态；位置是 t 的闭式函数，见文件头。
   */
  update(t: number, tips: readonly { x: number; y: number; reach: number }[]) {
    // 时间倒流：整个重来。状态是历史的函数，倒着走没有意义（同 TrailBuffer）
    if (t < this.lastT) this.reset();
    this.lastT = t;

    const p = this.params;

    // 第一次：一次性铺满整屏。不从底边一个个冒 —— 一开场屏幕上就该是满的。
    // 全部戳完之后这里不会再补：空了就是空了，那是这个玩具的终局
    if (!this.seeded) {
      this.seeded = true;
      for (let i = 0; i < p.count; i++) this.bubbles.push(this.spawn(i));
    }

    const live: Bubble[] = [];
    for (const b of this.bubbles) {
      const { x, y } = this.posAt(b, t);
      if (b.poppedAt === null) {
        /*
         * 判定半径取「泡泡的 popRadius 倍」和「指尖自己的容差」中**大的那个**。
         *
         * 只按泡泡半径算的话，手机上根本戳不中：泡泡半径是 size × 画布宽度，
         * 而手机竖屏的宽度是短边（约 390~780），桌面横屏是长边（1280+）——
         * 同一份参数在手机上泡泡小 2~4 倍，容差也跟着小 2~4 倍，
         * 再叠上手机摄像头分辨率更低、关键点更抖，就成了「怎么戳都不破」。
         *
         * 下限按**掌宽**算而不是按画面算：它是手自己的尺寸，人退远手变小、
         * 容差跟着变小，符合直觉；而且横屏竖屏都成立。
         */
        for (const tip of tips) {
          const pr = Math.max(b.r * p.popRadius, tip.reach);
          if (Math.hypot(tip.x - x, tip.y - y) < pr) {
            b.poppedAt = t;
            break;
          }
        }
      } else if (t - b.poppedAt > POP_SECONDS) {
        continue; // 残留动画放完就永久移除。破了不再生，所以能清空
      }
      live.push(b);
    }
    this.bubbles = live;

    /*
     * 先按 y 从远到近排序再写。
     *
     * 半透明物体的正确合成依赖绘制顺序，而深度测试对它没用。
     * 不排的话混合顺序就是槽位顺序，两个泡泡叠在一起时前后关系
     * 会跟着重生顺序随机变 —— 而且同一个 t 排两次得到的顺序必须一样，
     * 所以排序键里带上 t0 和半径打破平局，不能只按 y。
     */
    const sorted = this.bubbles
      .map((b) => ({ b, ...this.posAt(b, t) }))
      .sort((a, c) => a.y - c.y || a.b.t0 - c.b.t0 || a.b.r - c.b.r);

    let n = 0;
    for (const { b, x, y } of sorted) {
      if (n >= this.max) break;
      const pop = b.poppedAt === null ? 0 : Math.min(1, (t - b.poppedAt) / POP_SECONDS);
      // 没有重生，所以不需要淡入：所有泡泡从 t=0 起就都在
      const fadeIn = 1;
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
