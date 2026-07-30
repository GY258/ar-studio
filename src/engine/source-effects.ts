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
   * 体素化：把画面重建成 Minecraft 那样的方块世界。
   *
   * **块色来自当前帧的真实像素**，不是贴一张事先做好的场景图 ——
   * 所以构图和光照是「按构造」就匹配的，不需要任何对齐工作。
   * 配 mask.provider "person" + apply "outside" 就是「人完全不动，只有背景变方块」。
   *
   * 和 pixelate 的区别不在网格，在网格之外的三件事。只做网格的话得到的是马赛克，
   * 那是「画面糊了」；方块世界要的是「每个块是一个**实体**」：
   *   1. 调色板 —— MC 的方块贴图色域窄、饱和度高。但**不能硬拍成固定色**，
   *      那样光照就没了。做法是先找最近的方块色，再用原块自己的亮度去调制它，
   *      于是颜色变成 MC 的，明暗还是你房间的。
   *   2. 立方体的面 —— 顶边一道亮线、底边一道暗线。这是「这是个立方体」
   *      唯一真正读得出来的线索，没有它就只是彩色瓷砖。
   *   3. 接缝 —— 块与块之间压暗一点（环境光遮蔽）。方块要能一个个数出来。
   * 再加一点块内颗粒，因为 MC 的 16×16 贴图本来就是有噪点的，纯平色显得像 UI。
   *
   * 颗粒和一切随机都走 arHash(块坐标, seed)，**不含时间** —— 时间一进去，
   * 人不动画面也会自己沸腾，而且 renderAt(t) 就不再是纯函数。
   */
  voxel: `
    vec2 vCell = 1.0 / blocks;
    vec2 vId = floor( vMapUv * blocks );

    /*
     * 取 3×3 个方块的加权平均，不是只看自己这一块。
     *
     * **这是「像 Minecraft」和「像马赛克」的分界线，而我第一版判断错了。**
     * 我以为辨识度来自「每块颜色量化」，于是逐块独立量化一张有噪点的照片 ——
     * 出来必然是椒盐点：每块各自随机落到不同的调色板项上。
     * 而真实的 MC 场景是**大片连续的同一种方块**：一整面石头墙、一片草地。
     *
     * 相邻块共享大部分采样窗口，于是它们大概率落到同一个调色板项上 ——
     * 连续的色块区域是这么长出来的，不是靠更精细的量化。
     * 中心权重 4 / 边 2 / 角 1，保留一点局部特征，不至于糊成一片。
     */
    /*
     * 采样窗口的跨度**按块数自动放大**，不是固定的相邻一格。
     *
     * 窗口如果永远是 3×3 个块，块一调小窗口就跟着变小，噪声压不住 ——
     * 椒盐点会随着「调细」一起回来，于是又被迫把块调大，绕回原地。
     * 真正该保持不变的是「用画面上多大一片区域去估这块的颜色」，
     * 那是个和块大小无关的量（这里取短边的 ~11%）。
     *
     * 仍然只采 9 次，只是撒得更开。
     */
    float vSpread = max( 1.0, floor( blocks.y * 0.055 ) );

    vec3 vAcc = vec3( 0.0 );
    float vWsum = 0.0;
    vec3 vCenter = vec3( 0.0 );
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        // 块中心。用块中心而不是块内网格点：这里要的是「这一片大概什么颜色」
        vec2 su = ( vId + vec2( float(i), float(j) ) * vSpread + 0.5 ) * vCell;
        su = clamp( su, vec2( 0.001 ), vec2( 0.999 ) );
        float kw = ( i == 0 ? 2.0 : 1.0 ) * ( j == 0 ? 2.0 : 1.0 );
        /*
         * 仍然按蒙版加权：不加的话人体轮廓周围的块会吸到皮肤和头发的颜色，
         * 沿着人边上浮一圈肉色方块。块越大越明显。
         */
        float sm = maskAt( su );
        float w = kw * ( applyOutside > 0.5 ? 1.0 - sm : sm );
        vec3 sc = srcTexel( su ).rgb;
        if (i == 0 && j == 0) vCenter = sc;
        vAcc += sc * w;
        vWsum += w;
      }
    }
    // 整片都在「不该取样」的那一侧时退回本块中心，避免除零后一片黑
    vec3 vAvg = vWsum > 0.01 ? vAcc / vWsum : vCenter;

    /*
     * 平滑半径和**块大小解耦**。
     *
     * 这两件事我一开始绑在一起了：为了压掉椒盐点把块调大 —— 结果块一大，
     * 背景里什么都认不出来了。但「块多大」和「用多大范围的颜色去填这块」
     * 本来就是两个独立的选择：块小是为了保住细节，平滑是为了让相邻块
     * 落到同一个调色板项上。
     *
     * 0 = 每块只看自己（细节最多，也最容易椒盐）
     * 1 = 完全用 3×3 邻域（最连贯，也最糊）
     */
    vec3 vCol = mix( vCenter, vAvg, vSmooth );

    /*
     * 把暗部抬起来。MC 的世界里没有纯黑：天光是全局的。
     * 真实房间的暗部是 0.02~0.05，被 levels 量化直接归零 ——
     * 不抬的话半个背景死黑，读起来像渲染坏了。
     *
     * 抬地板 + 轻微 gamma，而不是整体加亮：整体加亮会冲爆本来就亮的地方，
     * 而「保住原始光照」是这个效果的前提。
     */
    vCol = vAmbient + ( 1.0 - vAmbient ) * pow( max( vCol, 0.0 ), vec3( 0.8 ) );

    /*
     * 提饱和**必须在平均之后**。
     *
     * 放在平均之前的话提的是传感器噪点的彩度 —— 一面米色的墙会长出
     * 淡紫、淡黄、淡蓝的杂色方块，正好是最毁效果的那种椒盐点。
     */
    float vLum = dot( vCol, vec3( 0.2126, 0.7152, 0.0722 ) );
    vCol = clamp( mix( vec3( vLum ), vCol, 1.0 + vSat ), 0.0, 1.0 );
    vCol = floor( vCol * vLevels + 0.5 ) / vLevels;

    /*
     * 往最近的方块色靠，但**保住原来的亮度**。
     *
     * 直接吸附成固定色的话，一面墙无论受光背光都变成同一块石头，光照就没了 ——
     * 而「匹配原始光照」正是这个效果存在的前提。所以吸附之后再按
     * 原块亮度 / 方块色亮度 缩放回去：颜色是 MC 的，明暗还是这一帧的。
     */
    vec3 vPal[16];
    vPal[0]  = vec3( 0.498, 0.698, 0.220 );  // 草方块顶
    vPal[1]  = vec3( 0.369, 0.549, 0.165 );  // 深草
    vPal[2]  = vec3( 0.290, 0.478, 0.149 );  // 树叶
    vPal[3]  = vec3( 0.525, 0.376, 0.263 );  // 泥土
    vPal[4]  = vec3( 0.690, 0.518, 0.310 );  // 橡木板
    vPal[5]  = vec3( 0.478, 0.478, 0.478 );  // 石头
    vPal[6]  = vec3( 0.588, 0.588, 0.588 );  // 圆石
    vPal[7]  = vec3( 0.298, 0.298, 0.298 );  // 深板岩
    vPal[8]  = vec3( 0.859, 0.827, 0.627 );  // 沙子
    vPal[9]  = vec3( 0.247, 0.463, 0.894 );  // 水
    vPal[10] = vec3( 0.941, 0.941, 0.941 );  // 雪 / 白色混凝土
    vPal[11] = vec3( 0.690, 0.180, 0.149 );  // 红色
    vPal[12] = vec3( 0.114, 0.114, 0.129 );  // 黑色
    vPal[13] = vec3( 0.588, 0.314, 0.247 );  // 红砖
    vPal[14] = vec3( 0.898, 0.769, 0.325 );  // 干草 / 金
    vPal[15] = vec3( 0.435, 0.647, 0.769 );  // 浅蓝 / 天空

    vec3 vBest = vCol;
    float vBestD = 1e9;
    for (int i = 0; i < 16; i++) {
      vec3 d = vPal[i] - vCol;
      float dd = dot( d, d );
      if (dd < vBestD) { vBestD = dd; vBest = vPal[i]; }
    }
    float vPalLum = max( 0.05, dot( vBest, vec3( 0.2126, 0.7152, 0.0722 ) ) );
    float vSrcLum = dot( vCol, vec3( 0.2126, 0.7152, 0.0722 ) );
    vec3 vSnapped = clamp( vBest * ( vSrcLum / vPalLum ), 0.0, 1.0 );
    vCol = mix( vCol, vSnapped, vPalette );

    /*
     * 同材质的深浅变化，**离散三档**而不是连续噪声。
     *
     * MC 的方块贴图里同一种材质是有明暗颗粒的（石头就是几档灰点），
     * 但它是离散的。连续噪声得到的是「脏」，离散档位得到的是「材质」——
     * 一整面墙里深一格浅一格地跳，正是石头墙该有的样子。
     *
     * 不含时间：一含时间人不动画面也会自己沸腾，而且 renderAt(t) 就不再是纯函数。
     */
    float vStep = floor( arHash( vId, vSeed ) * 3.0 ) - 1.0;
    vCol *= 1.0 + vStep * vGrain;

    /*
     * 立方体的面。顶边亮线 / 底边暗线 / 左侧微亮 ——
     * 这是「这是个立方体」唯一真正读得出来的线索，没有它就只是彩色瓷砖。
     *
     * 占块的 22%。第一版给 16%、接缝只有 6%，在 14px 的块上不到 1 个像素，
     * 被抗锯齿抹平，看起来就是「一张打了马赛克的照片」。
     */
    vec2 vF = fract( vMapUv * blocks );
    float vTop = 1.0 - smoothstep( 0.0, 0.22, vF.y );
    float vBot = smoothstep( 0.78, 1.0, vF.y );
    float vLeft = 1.0 - smoothstep( 0.0, 0.18, vF.x );
    vCol *= 1.0 + vFaceShade * ( vTop * 0.9 + vLeft * 0.35 - vBot * 0.8 );

    // 接缝：块与块之间压暗（环境光遮蔽），方块要能一个个数出来
    float vSeam = min( min( vF.x, vF.y ), min( 1.0 - vF.x, 1.0 - vF.y ) );
    vCol *= mix( 1.0 - vOutline, 1.0, smoothstep( 0.0, 0.14, vSeam ) );

    vec4 effectTexel = vec4( clamp( vCol, 0.0, 1.0 ), 1.0 );`,

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
