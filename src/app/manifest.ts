import type { MetadataRoute } from "next";

/**
 * PWA manifest。
 *
 * 装到主屏之后解决的是**摄像头权限反复弹**：iOS Safari 在普通标签页里
 * 每次页面加载都会问一次，而 standalone 模式下权限是持久的。
 * 顺带没有地址栏，竖屏能多出一块屏幕 —— 对满屏取景的相机类应用不是小事。
 *
 * 图标用内联 SVG（data URI 在 manifest 里不被 iOS 认，所以走真实路由）——
 * 见 icon.tsx / apple-icon.tsx，Next 会把它们编译成图片。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AR Studio",
    short_name: "AR Studio",
    description: "AR camera filters in your browser. Recording built in.",
    start_url: "/templates",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0B0B0D",
    theme_color: "#0B0B0D",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
