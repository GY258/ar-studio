/**
 * Fluidity：带编号的检测框 + 互相连接的细线，跟着人体运动实时抖动重组。
 *
 * ## 密度由**姿态**驱动，不由运动速度驱动
 *
 * 参考素材里「张开手臂时框和线爆发式增多、收拢时骤减」。看起来像是在响应
 * 动作快慢，其实差别在**姿态本身** —— 慢慢张开手臂一样该炸。
 * 所以密度取 `双腕间距 / 肩宽`（PoseFrame.spread），这是当前帧的纯函数：
 * 既对得上参考，又不引入跨帧状态，renderAt(t) 的无历史性照旧成立。
 *
 * ## 一帧一检测的机械跳动
 *
 * 所有随机量（编号、框的抖动、线连谁）都 key 在 `floor(t * detectHz)` 上，
 * 不做任何插值。参考素材要的就是那种「每帧重新检测」的生硬跳变 ——
 * 平滑插值会让它变成柔顺的装饰动画，完全是另一个东西。
 *
 * ## 编号是假的，但必须是确定的假
 *
 * 五位数编号走 `hash(第几个框, 第几个检测帧, seed)`。看着像每帧重新分配的
 * 检测 id，实际是纯函数 —— 用 Math.random() 的话 renderAt(t) 不再确定，
 * 整套 golden 回归当场塌掉。
 *
 * ## 数字用程序化点阵，不用字体
 *
 * 3×5 的位图字形直接写在 shader 里。这个仓库踩过：系统字体让 golden 只在
 * 录它的那台机器上成立。而且点阵反而更贴参考里那种「等宽像素风」。
 */

import * as THREE from "three";
import type { PoseFrame, PoseTracker } from "./pose-tracker";
import { POSE_BOX_POINTS } from "./pose-anchors";

/**
 * 多余的框往这些点上聚。手和头是「检测最活跃」的地方 ——
 * 参考素材里这几处各叠着五六个小框，躯干和腿上只有零星几个。
 * 存的是在 POSE_BOX_POINTS 里的下标。
 */
const HOT_POINTS = [0, 1, 2, 7, 8, 9, 10, 5, 6].filter((i) => i < POSE_BOX_POINTS.length);

/** 确定性 hash。整数雪崩混合 —— 不用 fract(sin(i*k))，那个在等差下标上会退化 */
function hash1(i: number, seed: number): number {
  let x = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x ^ Math.imul(seed | 0, 0xc2b2ae35), 0x27d4eb2f);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * 5×7 点阵数字。
 *
 * 原来是 3×5 —— 太方太粗，参考素材里的编号明显**更高更瘦**，
 * 是那种技术感的等宽小字。5×7 是点阵字库里最常见的数字字身比，
 * 笔画能细到 1 像素而字仍然读得出来。
 *
 * 位序：bit(row * 5 + col)，row 0 在上，col 0 在**左**（和 3×5 那版相反，
 * 那版把二进制串的低位当成了左列，整个字形水平镜像 —— 这次直接按左到右写）。
 *
 * 35 位放不进一个 float32（整数只精确到 2^24），所以拆成两半：
 * 前 4 行进 A（20 位），后 3 行进 B（15 位）。
 */
const GLYPH_ROWS: number[][] = [
  [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110], // 0
  [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110], // 1
  [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111], // 2
  [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110], // 3
  [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010], // 4
  [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110], // 5
  [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110], // 6
  [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000], // 7
  [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110], // 8
  [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100], // 9
];
/** 每行的位是「col 0 在最高位」写的，翻成「col 0 在最低位」好在 shader 里按位取 */
const rev5 = (r: number) => {
  let out = 0;
  for (let c = 0; c < 5; c++) if (r & (1 << (4 - c))) out |= 1 << c;
  return out;
};
const GLYPH_A = GLYPH_ROWS.map((rows) => rows.slice(0, 4).reduce((a, r, i) => a + rev5(r) * Math.pow(2, i * 5), 0));
const GLYPH_B = GLYPH_ROWS.map((rows) => rows.slice(4).reduce((a, r, i) => a + rev5(r) * Math.pow(2, i * 5), 0));

export interface FluidityParams {
  /** 最多几个框 */
  boxes: number;
  /** 最多几条线 */
  lines: number;
  /** 每秒重检测几次。编号跳变和抖动的节奏 */
  detectHz: number;
  /** 框位置抖动幅度，相对肩宽 */
  jitter: number;
  /** 框的**平均**大小，相对肩宽 */
  boxSize: number;
  /**
   * 大小差异程度 0~1。0 = 全一样大；1 = 大量小框 + 少数几个大框。
   * 不管调多少，**平均值恒等于 boxSize** —— 见 update() 里的推导。
   */
  boxSizeSpread: number;
  /** 多少比例的框带编号 0~1。参考素材里不是每个框都有 */
  labelRatio: number;
  /** 静止（spread=0）时还剩多少密度 0~1 */
  density: number;
  /** 多少比例的线拉出画面 0~1 */
  lineReach: number;
  /** 多少比例的**小**框是实心的 0~1 */
  fillRatio: number;
  /** 编号位数 */
  digits: number;
  /** 字高，相对肩宽。会吸到 7 的倍数（5×7 的行数），下限 7px */
  digitSize: number;
  color: string;
  opacity: number;
  seed: number;
}

export class FluidityField {
  readonly group = new THREE.Group();
  private readonly boxMesh: THREE.Mesh;
  private readonly digitMesh: THREE.Mesh;
  private readonly lineSeg: THREE.LineSegments;

  private readonly boxGeo: THREE.InstancedBufferGeometry;
  private readonly digitGeo: THREE.InstancedBufferGeometry;
  private readonly lineGeo: THREE.BufferGeometry;

  private readonly bPos: Float32Array;
  private readonly bSize: Float32Array;
  private readonly bAlp: Float32Array;
  private readonly bFill: Float32Array;
  private readonly dPos: Float32Array;
  private readonly dSize: Float32Array;
  private readonly dGlyphA: Float32Array;
  private readonly dGlyphB: Float32Array;
  private readonly dAlp: Float32Array;
  private readonly lPos: Float32Array;
  private readonly attrs: Record<string, THREE.InstancedBufferAttribute> = {};

  private W = 1280;
  private H = 720;

  constructor(
    private readonly params: FluidityParams,
    private readonly maxBoxes: number,
  ) {
    const maxDigits = maxBoxes * params.digits;
    this.bPos = new Float32Array(maxBoxes * 2);
    this.bSize = new Float32Array(maxBoxes * 2);
    this.bAlp = new Float32Array(maxBoxes);
    this.bFill = new Float32Array(maxBoxes);
    this.dPos = new Float32Array(maxDigits * 2);
    this.dSize = new Float32Array(maxDigits);
    this.dGlyphA = new Float32Array(maxDigits);
    this.dGlyphB = new Float32Array(maxDigits);
    this.dAlp = new Float32Array(maxDigits);
    this.lPos = new Float32Array(params.lines * 2 * 3);

    const color = new THREE.Color(params.color);
    const quad = new THREE.PlaneGeometry(1, 1);

    /* ---------------- 框：instanced quad，片元里只画描边 ---------------- */
    this.boxGeo = new THREE.InstancedBufferGeometry();
    this.boxGeo.index = quad.index;
    this.boxGeo.attributes.position = quad.attributes.position;
    for (const [name, arr, n] of [
      ["iPos", this.bPos, 2],
      ["iSize", this.bSize, 2],
      ["iAlp", this.bAlp, 1],
      ["iFill", this.bFill, 1],
    ] as [string, Float32Array, number][]) {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      this.boxGeo.setAttribute(name, a);
      this.attrs[`b_${name}`] = a;
    }
    this.boxGeo.instanceCount = maxBoxes;

    const boxMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: { uColor: { value: color }, uOpacity: { value: params.opacity } },
      vertexShader: `
        attribute vec2 iPos; attribute vec2 iSize; attribute float iAlp; attribute float iFill;
        varying vec2 vLocal; varying vec2 vSize; varying float vA; varying float vFill;
        void main(){
          vLocal = position.xy * 2.0;   // -1..1
          vSize = iSize; vA = iAlp; vFill = iFill;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(iPos + position.xy * iSize, 0.0, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uOpacity;
        varying vec2 vLocal; varying vec2 vSize; varying float vA; varying float vFill;
        void main(){
          if (vA < 0.004) discard;
          /*
           * 一部分框是**实心**的。参考素材里散着一些填实的白色小方块 ——
           * 全是描边的话画面读起来太均质，实心的那几个是节奏上的重音。
           */
          if (vFill > 0.5) {
            gl_FragColor = vec4(uColor, vA * uOpacity);
            return;
          }
          /*
           * 1px 描边。线宽按**像素**算而不是按框大小的比例 ——
           * 按比例的话小框的边细到看不见、大框的边粗成色块，
           * 而参考素材里所有框的边都是同一根 1px 白线。
           */
          vec2 edge = 1.0 / max(vSize, vec2(1.0));
          vec2 d = 1.0 - abs(vLocal);
          if (d.x > edge.x && d.y > edge.y) discard;
          gl_FragColor = vec4(uColor, vA * uOpacity);
        }`,
    });
    this.boxMesh = new THREE.Mesh(this.boxGeo, boxMat);
    this.boxMesh.frustumCulled = false;
    this.boxMesh.renderOrder = 7;

    /* ---------------- 数字：程序化 3×5 点阵 ---------------- */
    this.digitGeo = new THREE.InstancedBufferGeometry();
    this.digitGeo.index = quad.index;
    this.digitGeo.attributes.position = quad.attributes.position;
    for (const [name, arr, n] of [
      ["iPos", this.dPos, 2],
      ["iSize", this.dSize, 1],
      ["iGlyphA", this.dGlyphA, 1],
      ["iGlyphB", this.dGlyphB, 1],
      ["iAlp", this.dAlp, 1],
    ] as [string, Float32Array, number][]) {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      this.digitGeo.setAttribute(name, a);
      this.attrs[`d_${name}`] = a;
    }
    this.digitGeo.instanceCount = maxDigits;

    const digitMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: { uColor: { value: color }, uOpacity: { value: params.opacity } },
      vertexShader: `
        attribute vec2 iPos; attribute float iSize; attribute float iGlyphA; attribute float iGlyphB;
        attribute float iAlp;
        varying vec2 vUv; varying float vGA; varying float vGB; varying float vA;
        void main(){
          vUv = position.xy + 0.5;      // 0..1
          vGA = iGlyphA; vGB = iGlyphB; vA = iAlp;
          // 5:7 的字身比。等宽点阵，不是字体
          gl_Position = projectionMatrix * modelViewMatrix
            * vec4(iPos + position.xy * vec2(iSize * 5.0 / 7.0, iSize), 0.0, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uOpacity;
        varying vec2 vUv; varying float vGA; varying float vGB; varying float vA;
        void main(){
          if (vA < 0.004) discard;
          /*
           * 3 列 5 行。vUv.y 是自下而上，字形按自上而下写的，所以翻一下。
           *
           * 必须 clamp 到 0.999 再乘：vUv.y 正好是 0 的那一行像素算出
           * floor(1.0 * 5.0) = 5，越界被丢掉 —— **每个数字的最底下一行都没了**，
           * 0 看着像 ⊓、5 看着像 S。在 11px 的字上这个缺口不明显但确实是错的。
           */
          int col = int(floor(clamp(vUv.x, 0.0, 0.999) * 5.0));
          int row = int(floor(clamp(1.0 - vUv.y, 0.0, 0.999) * 7.0));
          /*
           * 取第 (row * 3 + col) 位。GLSL ES 1.0 没有整数位运算，
           * 用 floor(v / 2^k) 的奇偶性代替 —— 这是这类点阵字形的标准写法。
           */
          /*
           * 列要**反着取**（2 - col）。
           *
           * GLYPH_ROWS 里每行是按二进制串写的（001 表示最右那列亮），
           * 所以最低位对应的是**最右**列。而这里直接用 col 当位序的话
           * 最低位落到最左列 —— 整个字形水平镜像。
           * 对称的 0 和 8 看着正常，2、5、7 全反了，低分辨率下极难发现。
           */
          // 前 4 行在 A，后 3 行在 B —— 35 位放不进一个 float32
          float packed = row < 4 ? vGA : vGB;
          float bit = float((row < 4 ? row : row - 4) * 5 + col);
          float v = floor(packed / pow(2.0, bit));
          if (mod(v, 2.0) < 0.5) discard;
          gl_FragColor = vec4(uColor, vA * uOpacity);
        }`,
    });
    this.digitMesh = new THREE.Mesh(this.digitGeo, digitMat);
    this.digitMesh.frustumCulled = false;
    this.digitMesh.renderOrder = 7;

    /* ---------------- 连接线 ---------------- */
    this.lineGeo = new THREE.BufferGeometry();
    const lineAttr = new THREE.BufferAttribute(this.lPos, 3);
    lineAttr.setUsage(THREE.DynamicDrawUsage);
    this.lineGeo.setAttribute("position", lineAttr);
    this.lineSeg = new THREE.LineSegments(
      this.lineGeo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: params.opacity, depthTest: false }),
    );
    this.lineSeg.frustumCulled = false;
    this.lineSeg.renderOrder = 7;

    this.group.add(this.boxMesh, this.digitMesh, this.lineSeg);
  }

  setViewport(w: number, h: number) {
    this.W = w;
    this.H = h;
  }

  /**
   * 滑块实时改一个参数。名单见 tunables.ts —— 只收**不需要重建 mesh** 的那些。
   * 颜色和不透明度直接写 uniform，其余下一帧读 params 就生效。
   */
  setParam(name: string, value: number) {
    if (name === "opacity") {
      (this.boxMesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value = value;
      (this.digitMesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value = value;
      (this.lineSeg.material as THREE.LineBasicMaterial).opacity = value;
      return;
    }
    (this.params as unknown as Record<string, number>)[name] = value;
  }

  /** 这一帧画了几个框。测试靠它断言「舒展时炸开、收拢时骤减」 */
  private lastBoxCount = 0;
  /** 最低那个框的归一化 y（0 = 画面顶，1 = 画面底） */
  private lastLowest = 0;

  boxCount(): number {
    return this.lastBoxCount;
  }

  /**
   * 最低那个框在画面上的位置。
   *
   * 用来断言「框铺到了腿和脚上」。**不能用像素带去量** ——
   * 连接线也会落在下半部分，把断言污染到抓不到 bug：
   * 我把锚点取法从「均匀铺开」改回「取前缀」（框全挤在上半身），
   * 像素带那版照样绿。断言的形态得配得上失效的形态。
   */
  lowestBoxY(): number {
    return this.lastLowest;
  }

  hide() {
    this.group.visible = false;
    this.lastBoxCount = 0;
    this.lastLowest = 0;
  }

  update(t: number, tracker: PoseTracker, pose: PoseFrame | null) {
    if (!pose) {
      this.hide();
      return;
    }
    this.group.visible = true;

    const p = this.params;
    // 一帧一检测：所有随机量 key 在这个整数上，不插值。参考要的就是这种生硬跳变
    const f = Math.floor(t * p.detectHz);
    const sw = pose.shoulderWidth;

    /*
     * 框的数量随舒展度爆发。
     *
     * 静止时不清零而是留 25% —— 参考素材第 5 帧（手收在胸前）仍然有几个框，
     * 全清的话读起来像「检测丢了」而不是「没什么可解析的」。
     */
    const n = Math.max(3, Math.round(p.boxes * (p.density + (1 - p.density) * pose.spread)));

    /* ---------------- 框 + 编号 ---------------- */
    const centers: { x: number; y: number }[] = [];
    let bi = 0;
    let di = 0;
    for (let i = 0; i < n && bi < this.maxBoxes; i++) {
      /*
       * 前几个框固定一个关节一个，后面的才随机撒在人身上。
       *
       * 全随机的话关节上反而经常空着，而参考素材里头、手、肘、膝、脚
       * 是**一直**有框的，多出来的才是散落在轮廓上的。
       */
      /*
       * 少于关节数时**均匀铺开**取，不是取前 N 个。
       *
       * POSE_BOX_POINTS 是按解剖顺序排的（脸→肩→肘→腕→髋→膝→踝），
       * 取前缀的话静止时（框少）全挤在上半身，腿上一个都没有 ——
       * 第一版就是这样，看着像检测只认得上半截。
       */
      const anchorIdx =
        i < POSE_BOX_POINTS.length
          ? Math.floor((i * POSE_BOX_POINTS.length) / Math.min(n, POSE_BOX_POINTS.length)) % POSE_BOX_POINTS.length
          : /*
             * 多出来的框**偏向手和头**，不是均匀撒在所有关节上。
             *
             * 参考素材里密度不是平均的：头顶和两只手周围各叠着五六个小框，
             * 形成一簇；躯干和腿上只有零星几个。均匀撒的话每个关节一个，
             * 读起来像标注图不像「检测在这几处最活跃」。
             */
            HOT_POINTS[Math.floor(hash1(i * 977 + f * 31, p.seed) * HOT_POINTS.length) % HOT_POINTS.length];
      const lm = tracker.landmarkAt(pose, POSE_BOX_POINTS[anchorIdx]);
      if (!lm) continue;

      const h = (k: number) => hash1(i * 613 + f * 101 + k, p.seed);
      // 和背景平面、人脸、手部守同一个镜像约定：0.5 - x
      const cx = (0.5 - lm.x) * this.W + (h(1) - 0.5) * p.jitter * sw;
      const cy = (0.5 - lm.y) * this.H + (h(2) - 0.5) * p.jitter * sw;
      /*
       * 尺寸：给「平均大小」和「差异程度」两个旋钮，不给 min/max。
       *
       * min/max 那套的问题是**算不出平均值**：分布是 2.5 次幂（偏小），
       * [0.055, 1.05] 的平均其实是 0.34 个肩宽 —— 想「把框调小一点」
       * 得先在脑子里做一遍积分。
       *
       * 这里用 size = boxSize * (a + b * h^2.5)，取 E[h^2.5] = 1/3.5，
       * 令 a = 1 - spread、b = 3.5 * spread，于是 a + b/3.5 ≡ 1 ——
       * **不管差异调多少，平均值恒等于 boxSize**。
       *   spread = 0 → 全是一样大的框
       *   spread = 1 → 0~3.5 倍均值，大量小框 + 少数几个大框（参考的样子）
       */
      const sp = p.boxSizeSpread;
      const w = p.boxSize * (1 - sp + 3.5 * sp * Math.pow(h(3), 2.5)) * sw;
      // 长宽比也抖一下，全是正方形的话读起来像网格不像检测框
      const hgt = w * (0.6 + h(4) * 0.9);

      // 框同样吸到整像素：描边是按像素算宽度的，中心落在半像素上会变成两条半亮的线
      this.bPos[bi * 2] = Math.round(cx);
      this.bPos[bi * 2 + 1] = Math.round(cy);
      this.bSize[bi * 2] = Math.round(w);
      this.bSize[bi * 2 + 1] = Math.round(hgt);
      this.bAlp[bi] = 1;
      /*
       * 一部分框填实。参考素材里散着几个实心的白色小方块 ——
       * 全描边的话画面太均质，实心的那几个是节奏上的重音。
       *
       * 只挑**中小号**的填（0.45~1.3 倍均值）：
       *   - 大框填实会糊掉半个身子
       *   - 最小的那批填实只是几个像素点，看不出是方块 ——
       *     第一版写的是「小于均值」，结果全落在最小的那批上
       */
      const mean = p.boxSize * sw;
      const fillable = w > mean * 0.45 && w < mean * 1.3;
      this.bFill[bi] = fillable && hash1(i * 5171 + f * 37, p.seed) < p.fillRatio ? 1 : 0;
      centers.push({ x: cx, y: cy });

      /*
       * 只有一部分框带编号。参考素材里不是每个框都有 ——
       * 全带的话数字比框还抢眼，而它本来是「检测 id」这种次要信息。
       */
      if (hash1(i * 3301 + f * 29, p.seed) > p.labelRatio) {
        bi++;
        continue;
      }

      // 编号贴在左上角外侧，和参考一致
      /*
       * 字号有**像素下限**。
       *
       * 按肩宽算的话，人站远一点肩宽只有 60px，字号算下来 4px ——
       * 3×5 的点阵在 4px 上是一团次像素噪点，读不出是数字。
       * 参考素材里人也站得很远，但编号始终是清楚的小字。
       */
      /*
       * 字号**吸附到 5 的整数倍**，位置也吸附到整像素。
       *
       * 5×7 的点阵，字高不是 7 的倍数时每行占不满整数个像素 ——
       * 格线落在半个像素上，笔画粗细不匀、边上泛色。纯白本身没问题
       * （实测最亮像素就是 255,255,255），糊的是**边缘的采样**。
       * 像素风的字必须落在整像素上，这是这类字体的基本要求。
       */
      /*
       * 字高。**吸到 7 的倍数**（5×7 的行数），每行才正好占整数个像素 ——
       * 换字形时忘了改这个模数的话，格线会落回半像素上，笔画粗细不匀、边上泛色。
       *
       * 下限是 7px，也就是每行 1 个像素：5×7 点阵能读出来的极限。
       * 再小就是一团噪点，不如不画。
       */
      const ds = Math.max(7, Math.round((sw * p.digitSize) / 7) * 7);
      const snap = (v: number) => Math.round(v);
      const num = Math.floor(hash1(i * 7919 + f * 13, p.seed) * Math.pow(10, p.digits));
      for (let k = 0; k < p.digits && di < this.maxBoxes * p.digits; k++) {
        const digit = Math.floor(num / Math.pow(10, p.digits - 1 - k)) % 10;
        // 每个数字的宽度也吸到 3 的倍数，字距用整数，不然列宽还是会不匀
        this.dPos[di * 2] = snap(cx - w / 2) + Math.round((ds * 5) / 7 + 1) * k;
        this.dPos[di * 2 + 1] = snap(cy + hgt / 2 + ds * 0.7);
        this.dSize[di] = ds;
        this.dGlyphA[di] = GLYPH_A[digit];
        this.dGlyphB[di] = GLYPH_B[digit];
        this.dAlp[di] = 1;
        di++;
      }
      bi++;
    }
    for (let i = bi; i < this.maxBoxes; i++) this.bAlp[i] = 0;
    for (let i = di; i < this.maxBoxes * p.digits; i++) this.dAlp[i] = 0;
    this.lastBoxCount = bi;
    // 世界坐标 y 向上，转成 0(顶)~1(底) 的归一化
    let lowest = 0;
    for (let i = 0; i < bi; i++) lowest = Math.max(lowest, 0.5 - this.bPos[i * 2 + 1] / this.H);
    this.lastLowest = lowest;

    /* ---------------- 连接线 ---------------- */
    /*
     * 线的数量比框涨得更陡（1.6 次幂）。
     *
     * 参考素材里张开手臂那一帧，线的爆发比框明显得多 —— 线才是「Fluidity」
     * 那个名字指的东西，框只是骨架。线性关系下张开和收拢看着差不多。
     */
    /*
     * 线数留一个下限（8%）。
     *
     * 纯按 spread^1.6 的话手垂着时一条线都没有，而参考素材第 5 帧
     * （手收在胸前）仍然有几条 —— 全空读起来像「检测断了」，
     * 而这个效果要的是「一直在解析，只是现在没什么可解析的」。
     */
    const m = centers.length < 2 ? 0 : Math.round(p.lines * (0.08 + 0.92 * Math.pow(pose.spread, 1.6)));
    let li = 0;
    for (let j = 0; j < m && li < p.lines; j++) {
      const a = centers[Math.floor(hash1(j * 271 + f * 7, p.seed) * centers.length) % centers.length];
      const bIdx = Math.floor(hash1(j * 419 + f * 53, p.seed) * centers.length) % centers.length;
      let b = centers[bIdx];
      /*
       * 一部分线拉到画面边缘，不连到另一个框上。
       *
       * 参考素材里手臂张开时有几条线直接跨出画面 —— 这是「大跨度」的来源。
       * 全都框对框的话线永远困在人体轮廓内，读起来是网格不是流动。
       */
      /*
       * 只有 lineReach 那一小部分线拉出画面。第一版写死了 18% ——
       * 结果满屏都是横贯画面的长斜线，人体上的网状结构反而看不见了。
       * 参考素材里长线是点缀，主体是**框与框之间**连出来的网。
       */
      if (hash1(j * 811 + f * 17, p.seed) < p.lineReach) {
        const ang = hash1(j * 929 + f * 23, p.seed) * Math.PI * 2;
        b = { x: a.x + Math.cos(ang) * this.W, y: a.y + Math.sin(ang) * this.H };
      }
      if (a === b) continue;
      this.lPos[li * 6] = a.x;
      this.lPos[li * 6 + 1] = a.y;
      this.lPos[li * 6 + 2] = 8;
      this.lPos[li * 6 + 3] = b.x;
      this.lPos[li * 6 + 4] = b.y;
      this.lPos[li * 6 + 5] = 8;
      li++;
    }
    // 没用到的顶点塌到原点并靠 drawRange 裁掉 —— 留着旧数据会拖出乱线
    this.lineGeo.setDrawRange(0, li * 2);
    this.lineGeo.attributes.position.needsUpdate = true;

    for (const k of Object.keys(this.attrs)) this.attrs[k].needsUpdate = true;
  }

  dispose() {
    this.boxGeo.dispose();
    this.digitGeo.dispose();
    this.lineGeo.dispose();
    (this.boxMesh.material as THREE.Material).dispose();
    (this.digitMesh.material as THREE.Material).dispose();
    (this.lineSeg.material as THREE.Material).dispose();
  }
}
