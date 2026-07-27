import type { LocalizedText } from "@/engine/types";

/**
 * 全站文案。
 *
 * 界面语言是英文——目标用户在 Reels / TikTok，定价是美元。
 * PRD 11.4「是否需要中文版」还没定，所以先把所有字符串收口在这一个文件里：
 * 真要做 i18n 时，改的是这份数据的形状，不是几十个组件。
 */

export const COPY = {
  brand: "AR STUDIO",

  nav: {
    cta: "Start creating",
  },

  home: {
    heroLines: ["Real snow.", "On your shoulders.", "In your browser."],
    heroBody:
      "AR effects that land on you — not a flat filter stuck to the screen. Pick a template, hit record, and download a clip ready to post. No app, no upload, everything runs on your device.",
    ctaPrimary: "Start free",
    ctaSecondary: "Browse templates",

    privacyTitle: "Your footage never uploads.",
    privacyTitleMuted: " Everything runs on your device.",
    privacyBody:
      "Person detection and effect rendering both finish inside your browser. Not a single camera frame reaches our servers. That isn't a promise — it's how this stack works.",

    steps: [
      { n: "01", t: "Pick a template", d: "Snow Cloud is free. Open it and shoot — no account needed." },
      { n: "02", t: "Shoot into your camera", d: "Snow settles on your head and shoulders. Water splashes and runs off." },
      { n: "03", t: "Download the clip", d: "Recording is built in. Stop and you have a file, ready for Reels." },
    ],

    templatesTitle: "Templates",
  },

  templates: {
    title: "Templates",
    lede: "One-time purchase, not a subscription. Unlock once and it stays yours, including future updates to that template.",
    free: "Free",
  },

  studio: {
    loadingModel: "Loading the person-segmentation model…",
    modelFailed: (msg: string) => `Could not load the model: ${msg}`,
    openCamera: "Open camera",
    connecting: "Connecting…",
    cameraNote: "Your footage never uploads — everything runs on your device. Requires https:// or localhost.",
    retry: "Try again",
    dragHint: "Drag anywhere to move the prop",
    micLabel: "Record audio",
    record: "Record",
    stop: "Stop",
    tracking: "Person locked",
    waiting: "Looking for a person…",
    degraded: "mobile fallback",
    micDenied: "Microphone permission was denied — the clip will be silent.",

    resultDownload: (ext: string) => `Download ${ext}`,
    resultRetake: "Retake",
    webmWarning:
      "This browser can only export WebM. Reels and TikTok won't take that format — you'll need to convert to MP4 before posting.",

    unlockTitle: (name: string) => `Unlock “${name}”`,
    unlockBody: "Yours permanently. One-time purchase, not a subscription.",
    unlockCta: "Unlock",
    unlockBusy: "Working…",
    unlockLater: "Maybe later",
    unlockUnavailable:
      "Payments aren't switched on for this deployment yet, so this template can't be unlocked here.",
    unlockFailed: "Couldn't start checkout. Try again in a moment.",
  },

  /**
   * 摄像头被拒时给的是可操作的指引，不是报错码（PRD 4.2 非功能要求）。
   * 文案按浏览器 DOMException 的 name 分支。
   */
  cameraHelp: {
    NotAllowedError:
      "The browser blocked camera access. Click the icon on the left of the address bar → set Camera to Allow → reload this page.",
    NotFoundError:
      "No camera found. Check whether another app has taken it over, or whether an external camera is unplugged.",
    NotReadableError:
      "Another program is holding the camera. Quit Zoom, Teams, or any other tab with a video call, then try again.",
  } as Record<string, string>,

  footer: {
    privacy: "Privacy",
    terms: "Terms",
  },
} as const;

/** 模板名、滑块名这类随模板走的文案，优先英文，缺了退回中文。 */
export function t(text: LocalizedText): string {
  return text.en ?? text.zh;
}
