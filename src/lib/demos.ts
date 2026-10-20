/**
 * 主页上用到的示例片段：首屏取景器、滤镜列表、Gallery 都从这里取。
 *
 * 文件放在 public/demos/<照片名>-<slug>.mp4、.jpg（poster）和 -still.jpg（缩略图），
 * 都由 scripts/make-demo.ts 从一张照片渲染出来。
 * 列表为空时主页这几段都不渲染，不留空架子。
 */
export interface Demo {
  /** 对应的模板 slug，点卡片直接进这个模板 */
  template: string;
  video: string;
  poster: string;
  /** 已经套上效果的一帧，圆形缩略图和取景器背景用 */
  still: string;
  /** 滤镜列表里的一句话介绍 */
  blurb: string;
}

function demo(file: string, template: string, blurb: string): Demo {
  const base = `/demos/${file}-${template}`;
  return { template, video: `${base}.mp4`, poster: `${base}.jpg`, still: `${base}-still.jpg`, blurb };
}

export const DEMOS: Demo[] = [
  demo("skycandy", "candy-ghost", "A little ghost pours Halloween candy that bounces off your head."),
  demo("walk", "colorful-me", "You stay in color while the world around you turns black and white."),
  demo("window", "black-lodge", "Lucky slot machines and a glowing flame float above your heads."),
  demo("dinner", "fluidity", "Tracking boxes and live numbers trace you as you move through the frame."),
  demo("sky", "signal-lost", "Glitch bars and a lost-signal readout break up the picture."),
  demo("night", "crying", "Cartoon tears roll down your face for the dramatic days."),
  demo("grass", "lowres-life", "You stay sharp while everything around you turns to pixels."),
];
