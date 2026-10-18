/**
 * 主页「Examples」里放的示例片段。
 *
 * 文件放在 public/demos/<照片名>-<slug>.mp4 和 .jpg（首帧做 poster），
 * 由 scripts/make-demo.ts 从一张照片渲染出来。列表为空时主页整段不渲染，
 * 不留一个空架子。
 */
export interface Demo {
  /** 对应的模板 slug，点卡片直接进这个模板 */
  template: string;
  video: string;
  poster: string;
}

export const DEMOS: Demo[] = [
  { template: "colorful-me", video: "/demos/grass-colorful-me.mp4", poster: "/demos/grass-colorful-me.jpg" },
  { template: "black-lodge", video: "/demos/phantom-black-lodge.mp4", poster: "/demos/phantom-black-lodge.jpg" },
  { template: "signal-lost", video: "/demos/sky-signal-lost.mp4", poster: "/demos/sky-signal-lost.jpg" },
  { template: "lowres-life", video: "/demos/grass-lowres-life.mp4", poster: "/demos/grass-lowres-life.jpg" },
];
