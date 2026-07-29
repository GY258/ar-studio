/**
 * 帧效果的着色器片段。
 *
 * 单独一个文件，是为了让校验器能拿到「哪些 kind 真的实现了」而不用 import 整个引擎
 * （engine.ts 拖着 three 和 MediaPipe，校验器跑在服务端和 CI 脚本里，不该背这些）。
 *
 * 每种效果只负责算出 `effectTexel`，蒙版混合那一步是共用的，见 engine.ts。
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
  pixelate: `
    vec2 gridUv = (floor(vMapUv * blocks) + 0.5) / blocks;
    vec4 effectTexel = srcTexel( gridUv );`,

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
};

/** 引擎真正实现了的帧效果。校验器从这里取名单，两边不会再各写各的。 */
export const IMPLEMENTED_EFFECTS = Object.keys(EFFECT_SNIPPETS);
