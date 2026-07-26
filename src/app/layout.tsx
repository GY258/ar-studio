import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AR Studio · AR camera filters in your browser",
  description:
    "Pick a template, shoot into your camera, download the clip. No install. Your footage never uploads — everything runs on your device.",
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
