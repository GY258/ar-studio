import type { Config } from "tailwindcss";

/* 6.2 设计规范直接落成 token。改这里 = 改全站。 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0B0B0D",
        surface: "#151518",
        line: "#26262C",
        fg: "#F2F0EC",
        muted: "#8A8A93",
        accent: "#C9A0FF",
        gold: "#F0C674",
        rec: "#FF5A52",
        // 主页是浅色薄荷绿（工作台还是暗色）。只在 src/app/page.tsx 和 components/home 里用
        home: {
          bg: "#F4F8F7",
          panel: "#E7F1EE",
          card: "#FFFFFF",
          fg: "#17312C",
          muted: "#4E6661",
          hint: "#7A8F8A",
          line: "#D3E2DE",
          accent: "#26856F",
          "accent-hover": "#1F6B5A",
          dot: "#2F9E86",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        // 主页：标题和正文用 DM Sans，引导句和「关于我们」用 Source Serif，由 next/font 在 page.tsx 注入
        dm: ["var(--font-dm)", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "ui-serif", "Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "SF Mono", "Menlo", "monospace"],
      },
      fontSize: {
        // 字号阶梯：中间层级少而狠
        hero: ["clamp(44px, 9vw, 148px)", { lineHeight: "0.94", letterSpacing: "-0.03em" }],
        section: ["clamp(32px, 4.4vw, 48px)", { lineHeight: "1.0", letterSpacing: "-0.02em" }],
        card: ["20px", { lineHeight: "1.3", letterSpacing: "-0.01em" }],
        body: ["16px", { lineHeight: "1.7" }],
        note: ["12px", { lineHeight: "1.5", letterSpacing: "0.06em" }],
      },
      spacing: { 13: "3.25rem", 18: "4.5rem", 22: "5.5rem", 30: "7.5rem" },
      maxWidth: { content: "1280px" },
      borderRadius: { panel: "1.75rem" },
      transitionTimingFunction: { brand: "cubic-bezier(.22,1,.36,1)" },
      keyframes: {
        rise: { from: { opacity: "0", transform: "translateY(16px)" }, to: { opacity: "1", transform: "none" } },
        blink: { "50%": { opacity: "0.2" } },
      },
      animation: {
        rise: "rise .4s cubic-bezier(.22,1,.36,1) both",
        blink: "blink 1s steps(1) infinite",
      },
    },
  },
  plugins: [],
};

export default config;
