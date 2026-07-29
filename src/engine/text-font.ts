/**
 * 内嵌字体的加载。
 *
 * 走 data URI 而不是 /public 下的文件：离线 harness 的那个小 http 服务只伺候
 * /harness.js 和 /fixtures/*，任何额外请求都是 404。字体一旦要联网或要额外路由，
 * 「断网、无摄像头、无 GPU 也能跑」这条就破了。
 */

import { NUNITO_LATIN_WOFF2_BASE64 } from "./font-data";

/** 栅格化文字时用的 family 名。用自己的名字，避免撞上系统里同名的 Nunito。 */
export const TEXT_FONT_FAMILY = "ARStudioText";

let ready: Promise<void> | null = null;

/**
 * 保证内嵌字体已经可用。多次调用只加载一次。
 *
 * **加载失败不抛错**，退回系统字体栈：一个字体的问题不该让整个模板画不出来。
 * 代价是那种情况下 golden 又变得和机器相关 —— 但那是降级路径，不是常态。
 */
export function ensureTextFont(): Promise<void> {
  if (ready) return ready;

  ready = (async () => {
    if (typeof FontFace === "undefined" || typeof document === "undefined") return;
    const face = new FontFace(
      TEXT_FONT_FAMILY,
      `url(data:font/woff2;base64,${NUNITO_LATIN_WOFF2_BASE64}) format("woff2")`,
      { weight: "400 900" },
    );
    await face.load();
    document.fonts.add(face);
  })().catch(() => {
    // 静默降级，见上
  });

  return ready;
}
