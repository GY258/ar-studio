/**
 * 主页「Examples」里放的示例片段。
 *
 * 文件放在 public/demos/<slug>.mp4 和 <slug>.jpg（首帧做 poster），
 * 由 scripts/make-demo.ts 从一张照片渲染出来。列表为空时主页整段不渲染，
 * 不留一个空架子。
 */
export interface Demo {
  /** 对应的模板 slug，点卡片直接进这个模板 */
  template: string;
  video: string;
  poster: string;
}

export const DEMOS: Demo[] = [];
