/**
 * 帧效果的着色器片段。
 *
 * 单独一个文件，是为了让校验器能拿到「哪些 kind 真的实现了」而不用 import 整个引擎
 * （engine.ts 拖着 three 和 MediaPipe，校验器跑在服务端和 CI 脚本里，不该背这些）。
 *
 * 每种效果只负责算出 `effectTexel`，蒙版混合那一步是共用的，见 engine.ts。
 * 片段里可以直接用 `m`（蒙版值，1 = 人）—— 它在片段之前就算好了，
 * 需要「按人/背景加权取样」的效果（马赛克）靠它。
 *
 * 三条纪律：
 *  1. 取样一律走 `srcTexel()`，它内部补了视频纹理的 sRGB 解码；
 *  2. 需要按亮度做判断的（灰度、色阶）必须在解码**之后**做，
 *     否则权重算在错误的色彩空间里，灰会偏；
 *  3. 这张表是「哪些 kind 实现了」的唯一事实来源 —— 引擎用它决定要不要装效果，
 *     校验器用同一份名单拦截。以前 blur 能过校验、能正常渲染、什么都不做也不报错，
 *     就是因为「校验器认识的 kind」和「引擎实现了的 kind」是两份各写各的名单。
 */

export const EFFECT_SNIPPETS: Record<string, string> = {
  /*
   * 马赛克。块内 2×2 取样，按「属不属于吃效果的那一侧」加权。
   *
   * 原来是块中心一个点采到底。块很大时（blocks 56 → 1080p 下每块约 34px）
   * 边界上的块一半是人一半是背景，中心点落在人身上就整块用人的颜色 ——
   * 于是人体轮廓外面浮着一圈肤色/发色的方块，看着像人溢出来了。
   * 这跟蒙版准不准无关，是取样本身跨了边界。
   *
   * 加权而不是直接排除：权重连续，块从「全背景」过渡到「全人」时颜色也连续，
   * 硬排除会在某个块上突然跳一下。
   *
   * 为什么只有 2×2：这是全屏每像素都要跑的，4 次画面取样 + 4 次蒙版取样已经是
   * 移动端能接受的上限。真要块内均值应该走 mipmap 或者单独一个降采样 pass，
   * 那是另一笔基建。
   */
  pixelate: `
    vec2 cellSize = 1.0 / blocks;
    vec2 cellUv = floor(vMapUv * blocks) * cellSize;
    vec4 blockAcc = vec4( 0.0 );
    float blockW = 0.0;
    for (int by = 0; by < 2; by++) {
      for (int bx = 0; bx < 2; bx++) {
        vec2 sampleUv = cellUv + cellSize * (vec2(float(bx), float(by)) + 0.5) * 0.5;
        float sampleMask = maskAt( sampleUv );
        // outside 时背景权重高，inside 时反过来
        float wgt = applyOutside > 0.5 ? 1.0 - sampleMask : sampleMask;
        blockAcc += srcTexel( sampleUv ) * wgt;
        blockW += wgt;
      }
    }
    // 整块都在「不该取样」的那一侧时退回块中心，避免除零后一片黑
    vec4 effectTexel = blockW > 0.01 ? blockAcc / blockW : srcTexel( cellUv + cellSize * 0.5 );`,

  blur: `
    // 3x3 二项式核（1 2 1 的外积）。九次采样，比等权平均干净，成本一样。
    // 半径大的时候会看出是九个影子而不是真高斯，那时候该加降采样通道，不是加采样数。
    vec4 effectTexel = vec4( 0.0 );
    effectTexel += srcTexel( vMapUv + vec2(-blurStep.x, -blurStep.y) ) * 0.0625;
    effectTexel += srcTexel( vMapUv + vec2(        0.0, -blurStep.y) ) * 0.125;
    effectTexel += srcTexel( vMapUv + vec2( blurStep.x, -blurStep.y) ) * 0.0625;
    effectTexel += srcTexel( vMapUv + vec2(-blurStep.x,         0.0) ) * 0.125;
    effectTexel += sharpTexel * 0.25;
    effectTexel += srcTexel( vMapUv + vec2( blurStep.x,         0.0) ) * 0.125;
    effectTexel += srcTexel( vMapUv + vec2(-blurStep.x,  blurStep.y) ) * 0.0625;
    effectTexel += srcTexel( vMapUv + vec2(        0.0,  blurStep.y) ) * 0.125;
    effectTexel += srcTexel( vMapUv + vec2( blurStep.x,  blurStep.y) ) * 0.0625;`,

  desaturate: `
    float lum = dot( sharpTexel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    vec4 effectTexel = vec4( mix( sharpTexel.rgb, vec3( lum ), amount ), sharpTexel.a );`,

  /*
   * 数字信号损坏：横向错位 + RGB 通道分离 + 色块乱码 + 扫描线。
   *
   * **全部是 hash(块, 帧号, seed) 的纯函数，一个随机数都没有。**
   * 用 Math.random() 或读挂钟的话，renderAt(t) 就不再是「同一份输入渲染多少次都是
   * 同一张图」，整套 golden 回归当场塌掉。时间也是离散的（floor(uTime * speed)）——
   * 既是为了确定性，也是因为真实的信号损坏本来就是一跳一跳的，连续飘反而假。
   *
   * darkBias 是这个效果「对味」的关键：参考素材里乱码几乎全在头发和深色衣服上，
   * 浅色皮肤是干净的。不按亮度加权的话脸上也会花，立刻变成廉价滤镜。
   */
  glitch: `
    float gFrame = floor( uTime * gSpeed );

    /*
     * 先用**未错位**的采样算暗部权重，再拿它去调制后面三路损坏。
     *
     * 第一版只有色块乱码吃了这个权重，错位和通道分离是全画面无差别的 ——
     * 结果是整行整行地平移把脸拉花了，嘴和鼻子被切断，而参考素材里脸是完好的。
     * 「只有暗部坏」必须贯穿所有三路，否则最显眼的那一路（错位）照样毁脸。
     *
     * 取 2.2 次幂是因为线性权重下中间调（受光的脸颊）仍然会花。
     */
    vec4 gBase = srcTexel( vMapUv );
    float gLum = dot( gBase.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    float gDark = pow( mix( 1.0, 1.0 - smoothstep( 0.06, 0.34, gLum ), gDarkBias ), 2.2 );

    // 行错位：整行整行地平移，这是「数据错位」最识别得出来的特征。
    // 乘 gDark 之后只有暗部会被拉走，亮的皮肤留在原地
    float gRow = floor( vMapUv.y * gBlocks );
    float rowRand = arHash( vec2( gRow, gFrame ), gSeed );
    // 只有一部分行会错位，全错的话读起来是「画面在抖」而不是「数据坏了」
    float rowShift = step( 0.72, rowRand ) * ( arHash( vec2( gRow, gFrame + 7.0 ), gSeed ) - 0.5 ) * gDisplace * gDark;
    vec2 gUv = vec2( fract( vMapUv.x + rowShift ), vMapUv.y );

    // 通道分离：R 和 B 往两边错开，G 留在原地。
    // 亮部保留一点点（0.25）当底噪，全关掉的话脸会显得太干净、和暗部脱节
    float gSplit = gChannelSplit * mix( 0.25, 1.0, gDark );
    vec4 gCenter = srcTexel( gUv );
    float gR = srcTexel( vec2( fract( gUv.x + gSplit ), gUv.y ) ).r;
    float gB = srcTexel( vec2( fract( gUv.x - gSplit ), gUv.y ) ).b;
    vec3 gRgb = vec3( gR, gCenter.g, gB );

    /*
     * 色块乱码，两级网格。
     *
     * 单级（一个细网格均匀撒）出来的是彩色胡椒粉，读作噪点不是数据损坏。
     * 真实的坏块是**成簇**的：某一片数据坏了，那一整片才碎。
     * 所以先用粗网格决定「这一片坏没坏」，再在坏掉的片里用细网格出块。
     *
     * 细网格取竖条（宽格数 > 高格数），因为视频数据是按行存的，
     * 坏起来是一条一条的竖直碎片，方块反而不像。
     */
    vec2 gRegion = floor( vMapUv * vec2( 13.0, 9.0 ) );
    float gRegionOn = step( 0.52, arHash( gRegion + vec2( 0.0, gFrame * 3.0 ), gSeed ) );
    vec2 gCell = floor( vMapUv * vec2( gBlocks * 2.0, gBlocks * 0.45 ) );
    float gPick = arHash( gCell + vec2( 0.0, gFrame * 13.0 ), gSeed );
    float gOn = gRegionOn * step( 1.0 - gColorNoise * 0.55 * gDark, gPick );
    vec3 gNoise = vec3(
      arHash( gCell + vec2( 1.7, gFrame ), gSeed ),
      arHash( gCell + vec2( 9.1, gFrame ), gSeed ),
      arHash( gCell + vec2( 4.3, gFrame ), gSeed )
    );
    // 归一化到高饱和：直接用 hash 会得到一堆灰扑扑的中间色
    gNoise = gNoise / max( 0.001, max( gNoise.r, max( gNoise.g, gNoise.b ) ) );
    gRgb = mix( gRgb, gNoise, gOn );

    // 扫描线：全画面无差别，它读作 CRT 而不是数据损坏，压在脸上不碍事
    float gScan = 1.0 - gScanline * 0.5 * ( 1.0 - abs( fract( vMapUv.y * gBlocks * 3.0 ) * 2.0 - 1.0 ) );
    vec4 effectTexel = vec4( gRgb * gScan, gCenter.a );`,

  /*
   * 调试用：把蒙版本身画出来，不做任何效果。
   *
   * 存在的理由是「不要透过马赛克看蒙版」—— 抠图不准的时候，
   * 你同时在看蒙版的边界和效果自己的块状边缘，两个未知量叠在一起，
   * 调哪个都像没用。这个视图把蒙版单独摘出来：
   *   红色 = 蒙版判定为人，越实心置信度越高
   *   绿色细线 = 过渡带（0.05 < m < 0.95），头发丝应该落在这里而不是被切成硬边
   */
  "mask-debug": `
    vec4 effectTexel = sharpTexel;`,
};

/**
 * 需要自己接管最后一步合成的 kind。缺省是「按蒙版在原图和效果之间混」，
 * 调试视图不属于这个模式 —— 它要画的就是蒙版本身。
 */
export const EFFECT_COMBINE: Record<string, string> = {
  "mask-debug": `
    float edge = step(0.05, m) * step(m, 0.95);
    vec3 dbg = mix( sharpTexel.rgb * 0.55, vec3( 1.0, 0.15, 0.15 ), m * 0.75 );
    dbg = mix( dbg, vec3( 0.1, 1.0, 0.2 ), edge * 0.85 );
    diffuseColor.rgb = dbg;`,
};

/** 引擎真正实现了的帧效果。校验器从这里取名单，两边不会再各写各的。 */
export const IMPLEMENTED_EFFECTS = Object.keys(EFFECT_SNIPPETS);
