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
    heroLines: ["Little moments,", "a little more magical."],
    heroBody:
      "A free AI-powered instant camera inspired by the filters we fell in love with on Instagram. Take a photo, try a new look, and turn an ordinary moment into something special.",
    ctaPrimary: "Try the camera →",

    examplesTitle: "Gallery",
    examplesBody: "Real clips, straight out of the camera. Tap one to try that look yourself.",

    aboutTitle: "A little about us ♡",
    aboutParagraphs: [
      "We're a long-distance couple who love building little things that make people's lives a bit more fun.",
      "We saw a filter trending on Instagram and thought, why not make a free instant camera that everyone can use? So we built one.",
      "One of us loves AI engineering. The other brings a passion for Spanish travel and culture. Together, we're exploring how small ideas and a little technology can bring people joy.",
    ],

    ideaTitle: "Have an idea? We'd love to hear it.",
    ideaBody:
      "Tell us what feature you'd like us to build next. This little project is for everyone, and your ideas can help shape it.",
    ideaCta: "Leave us a message",

    instagramTitle: "Follow our journey on Instagram",
    instagramBody: "We're building this together, one little idea at a time. Follow along to see what we make next.",
    instagramHandle: "@ginagary.moments",
    // 分享链接里带的 ?rpxt= 是追踪参数，主页上不要
    instagramUrl: "https://www.instagram.com/ginagary.moments/",
    instagramPhotos: ["/about/ig-1.jpg", "/about/ig-2.jpg", "/about/ig-3.jpg"],

    privacyTitle: "Your footage never uploads.",
    privacyTitleMuted: " Everything runs on your device.",
    privacyBody:
      "Person detection and effect rendering both finish inside your browser. Not a single camera frame reaches our servers. That isn't a promise — it's how this stack works.",

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
    flipCamera: "Flip camera",
    hideUi: "Hide UI",
    recordStart: "Start recording",
    recordStop: "Stop recording",
    settings: "Settings",
    // 完整视野那一档是算出来的小数（比如 0.31），显示两位以内，别出现 0.3125
    zoomLabel: (z: number) => (z === 1 ? "1×" : z < 1 ? z.toFixed(1) : String(z)),
    installTitle: "Add to Home Screen",
    installBody: "Tap Share, then “Add to Home Screen”. The camera permission sticks, and you get the full screen.",
    installDismiss: "Not now",
    showUi: "Show controls",
    record: "Record",
    stop: "Stop",
    tracking: "Person locked",
    waiting: "Looking for a person…",
    degraded: "mobile fallback",
    micDenied: "Microphone permission was denied — the clip will be silent.",

    resultDownload: (ext: string) => `Download ${ext}`,
    saveToPhotos: "Save to Photos",
    savedHint: "Pick “Save Video” in the share sheet.",
    saveUnsupported: "This browser can’t save to Photos — use Download instead.",
    saveWebmHint: "Photos only accepts MP4. This clip is WebM — download it instead.",
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
