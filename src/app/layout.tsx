import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AR Studio · AR camera filters in your browser",
  description:
    "Pick a template, shoot into your camera, download the clip. No install. Your footage never uploads — everything runs on your device.",
  /*
   * iOS 上「添加到主屏幕」之后要以 standalone 打开，靠的是这个 meta。
   * manifest 里的 display: "standalone" 对 iOS Safari **不生效** ——
   * 它只认 apple-mobile-web-app-capable。两个都写才两边都对。
   */
  appleWebApp: {
    capable: true,
    title: "AR Studio",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    title: "AR Studio",
    description: "AR camera filters in your browser. Recording built in.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0B0B0D",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-[100dvh]">
      <body className="min-h-[100dvh]">{children}</body>
    </html>
  );
}
