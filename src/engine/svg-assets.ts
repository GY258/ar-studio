/**
 * 内联 SVG 素材。来源：Teardrop Sticker Kit。
 */

export const SVG_ASSETS: Record<string, string> = {

  /* ---- Crying filter: tear streaks ---- */

  "tear-streak-left": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 58 56" fill="none">
  <g stroke="#62C3F2" stroke-linecap="round" fill="none">
    <path d="M8 14H38" stroke-width="24"/>
    <path d="M38 18c4 10 2 18-4 28" stroke-width="18"/>
  </g>
  <ellipse cx="12" cy="10" rx="5" ry="4" fill="#fff" fill-opacity=".55"/>
</svg>`,

  "tear-streak-right": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 58 56" fill="none">
  <g transform="translate(58 0) scale(-1 1)">
    <g stroke="#62C3F2" stroke-linecap="round" fill="none">
      <path d="M8 14H38" stroke-width="24"/>
      <path d="M38 18c4 10 2 18-4 28" stroke-width="18"/>
    </g>
    <ellipse cx="12" cy="10" rx="5" ry="4" fill="#fff" fill-opacity=".55"/>
  </g>
</svg>`,

  "tear-drop": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 34" fill="none">
  <path d="M12 1.5c0 0 9.5 14.6 9.5 20.6a9.5 9.5 0 1 1-19 0C2.5 16.1 12 1.5 12 1.5Z" fill="#62C3F2"/>
  <path d="M12 1.5c0 0 9.5 14.6 9.5 20.6a9.5 9.5 0 1 1-19 0C2.5 16.1 12 1.5 12 1.5Z" fill="url(#tdShade)"/>
  <ellipse cx="8.2" cy="23.5" rx="2.4" ry="3.6" transform="rotate(-18 8.2 23.5)" fill="#fff" fill-opacity=".65"/>
  <defs>
    <linearGradient id="tdShade" x1="4" y1="4" x2="20" y2="32" gradientUnits="userSpaceOnUse">
      <stop stop-color="#8FD8FA"/><stop offset="1" stop-color="#4FB4EC"/>
    </linearGradient>
  </defs>
</svg>`,

  "tear-splash": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 40" fill="none">
  <circle cx="16" cy="24" r="11" fill="#62C3F2"/>
  <circle cx="55" cy="26" r="9" fill="#62C3F2"/>
  <circle cx="73" cy="20" r="6.5" fill="#62C3F2"/>
  <circle cx="84" cy="29" r="4.5" fill="#62C3F2"/>
  <circle cx="12.5" cy="20" r="3.2" fill="#fff" fill-opacity=".6"/>
  <circle cx="52" cy="23" r="2.6" fill="#fff" fill-opacity=".6"/>
</svg>`,

  /* ---- Emotion Folders filter ---- */

  "folder": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 112 92" fill="none">
  <defs>
    <linearGradient id="fldFront" x1="56" y1="30" x2="56" y2="88" gradientUnits="userSpaceOnUse">
      <stop stop-color="#9AD3F6"/><stop offset="1" stop-color="#4BA6E6"/>
    </linearGradient>
    <linearGradient id="fldBack" x1="56" y1="6" x2="56" y2="34" gradientUnits="userSpaceOnUse">
      <stop stop-color="#8FCDF4"/><stop offset="1" stop-color="#63B6EC"/>
    </linearGradient>
  </defs>
  <path d="M6 14a8 8 0 0 1 8-8h26l10 12h46a8 8 0 0 1 8 8v14H6V14Z" fill="url(#fldBack)"/>
  <rect x="4" y="24" width="104" height="64" rx="10" fill="url(#fldFront)"/>
  <rect x="4" y="24" width="104" height="10" fill="#fff" fill-opacity=".18"/>
  <g fill="#fff">
    <path d="M42 56a11 11 0 0 1 10.8-11 14 14 0 0 1 26.2 4.3A9 9 0 0 1 77 67H52a11 11 0 0 1-10-11Z" fill-opacity=".95"/>
    <circle cx="53" cy="76" r="3.2" fill-opacity=".9"/>
    <circle cx="64" cy="79" r="3.2" fill-opacity=".9"/>
    <circle cx="75" cy="76" r="3.2" fill-opacity=".9"/>
  </g>
</svg>`,

  /* ---- Crayon Rain filter ---- */

  "crayon-drop": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 170" fill="none">
  <defs>
    <filter id="crayon" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="3" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="6" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>
  <g filter="url(#crayon)" stroke="#5B94F0" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M60 14c-3 10-11 24-18 38-8 16-14 30-14 44 0 20 15 33 32 33s32-13 32-33c0-14-6-28-14-44-7-14-15-28-18-38Z"/>
  </g>
</svg>`,

  "crayon-drop-solid": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 170" fill="none">
  <defs>
    <filter id="crayon2" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.055" numOctaves="3" seed="21" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="7" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>
  <g filter="url(#crayon2)" stroke="#5B94F0" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M62 16c-6 14-16 30-23 44-6 13-11 26-9 38 3 19 18 30 34 28 17-2 28-16 27-35-1-15-8-30-15-44-6-12-11-22-14-31Z"/>
    <path d="M52 118c4 6 12 7 17 2" stroke-width="7"/>
  </g>
</svg>`,
};

/** 把 SVG 字符串渲染到 canvas 上 */
export function rasterizeSvg(
  svgStr: string,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG rasterization failed"));
    };
    img.src = url;
  });
}

/** 把文字渲染到 canvas 上 */
export function rasterizeText(
  text: string,
  fontSize: number,
  color: string,
  fontWeight: number,
  shadow?: string,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = `${fontWeight} ${fontSize}px "SF Pro Rounded","Nunito","Inter",system-ui,sans-serif`;
  ctx.font = font;
  const m = ctx.measureText(text);
  const pad = fontSize * 0.5;
  c.width = Math.ceil(m.width + pad * 2);
  c.height = Math.ceil(fontSize * 1.5 + pad * 2);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (shadow) {
    const parts = shadow.match(/([^\s]+)/g) || [];
    ctx.shadowOffsetX = parseFloat(parts[0] || "0");
    ctx.shadowOffsetY = parseFloat(parts[1] || "0");
    ctx.shadowBlur = parseFloat(parts[2] || "0");
    ctx.shadowColor = parts.slice(3).join(" ") || "rgba(0,0,0,.4)";
  }
  ctx.fillStyle = color;
  ctx.fillText(text, c.width / 2, c.height / 2);
  return c;
}
