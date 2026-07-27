/**
 * 内联 SVG 素材。避免外部加载，滤镜激活即可渲染。
 */

export const SVG_ASSETS: Record<string, string> = {
  folder: `<svg viewBox="0 0 72 64" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="fgBody" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#B5DAF4"/><stop offset="0.45" stop-color="#8CC7F3"/><stop offset="1" stop-color="#6FB4EF"/>
  </linearGradient>
  <linearGradient id="fgTab" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#A9D4F4"/><stop offset="1" stop-color="#8CC7F3"/>
  </linearGradient>
</defs>
<path d="M4 12 q0-5 5-5 h16 q4 0 6 3 l3 4 h-30 z" fill="url(#fgTab)"/>
<rect x="4" y="12" width="64" height="46" rx="7" fill="url(#fgBody)"/>
<rect x="4" y="12" width="64" height="6" rx="3" fill="#C9E4F8" opacity="0.85"/>
<g>
  <ellipse cx="34" cy="36" rx="13" ry="8.5" fill="#FCFFFF"/>
  <circle cx="27" cy="33" r="6.5" fill="#FCFFFF"/>
  <circle cx="38" cy="31" r="7.5" fill="#FCFFFF"/>
  <circle cx="46" cy="35" r="5.5" fill="#FCFFFF"/>
  <path d="M46 42 q3.5 4 0 7 q-3.5-3 0-7 z" fill="#5FAEE8"/>
</g>
</svg>`,

  "crayon-drop": `<svg viewBox="0 0 100 200" xmlns="http://www.w3.org/2000/svg">
<defs>
<filter id="crayon" x="-20%" y="-20%" width="140%" height="140%">
  <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="3" seed="7" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="9"/>
  <feComponentTransfer><feFuncA type="gamma" amplitude="1" exponent="1.35" offset="0"/></feComponentTransfer>
</filter>
</defs>
<path d="M50 12 C 58 48, 88 92, 88 136 a38 44 0 1 1 -76 0 C 12 92, 42 48, 50 12 Z"
      fill="none" stroke="#7CA3E8" stroke-width="15" stroke-linejoin="round"
      filter="url(#crayon)" opacity="0.92"/>
</svg>`,

  "crayon-drop-solid": `<svg viewBox="0 0 100 200" xmlns="http://www.w3.org/2000/svg">
<defs>
<filter id="crayonS" x="-20%" y="-20%" width="140%" height="140%">
  <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="3" seed="3" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="9"/>
  <feComponentTransfer><feFuncA type="gamma" amplitude="1" exponent="1.35" offset="0"/></feComponentTransfer>
</filter>
</defs>
<path d="M50 30 C 56 60, 80 95, 80 135 a30 36 0 1 1 -60 0 C 20 95, 44 60, 50 30 Z"
      fill="#7CA3E8" filter="url(#crayonS)" opacity="0.9"/>
</svg>`,

  "tear-t": `<svg viewBox="0 0 100 70" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7EC8E3"/><stop offset="1" stop-color="#5BB5D8"/>
  </linearGradient>
</defs>
<!-- T 型：横杆 + 两个下挂圆头 -->
<path d="M12 16 Q50 4 88 16" fill="none" stroke="url(#tg)" stroke-width="12" stroke-linecap="round"/>
<ellipse cx="22" cy="38" rx="11" ry="14" fill="url(#tg)"/>
<ellipse cx="78" cy="38" rx="11" ry="14" fill="url(#tg)"/>
<!-- 连接横杆到圆头 -->
<rect x="14" y="14" width="14" height="20" rx="4" fill="url(#tg)"/>
<rect x="70" y="14" width="14" height="20" rx="4" fill="url(#tg)"/>
<!-- 高光 -->
<ellipse cx="22" cy="34" rx="5" ry="4" fill="#FFFFFF" opacity="0.55"/>
<ellipse cx="78" cy="34" rx="5" ry="4" fill="#FFFFFF" opacity="0.55"/>
</svg>`,

  "tear-drop": `<svg viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg">
<defs>
  <radialGradient id="td" cx="0.4" cy="0.35" r="0.6">
    <stop offset="0" stop-color="#A8DEF0"/><stop offset="1" stop-color="#5BB5D8"/>
  </radialGradient>
</defs>
<circle cx="15" cy="15" r="12" fill="url(#td)"/>
<ellipse cx="11" cy="11" rx="4" ry="3" fill="#FFFFFF" opacity="0.5"/>
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
  const font = `${fontWeight} ${fontSize}px "SF Pro Rounded","Nunito","Inter",sans-serif`;
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
