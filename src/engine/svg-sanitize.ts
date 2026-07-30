/**
 * SVG 安全清洗。inline SVG 是用户输入通道（经由 LLM），必须过滤危险内容。
 * 拒收而不是静默清洗——LLM 需要看到报错才能改。
 */

const ALLOWED_TAGS = new Set([
  "svg", "path", "rect", "circle", "ellipse", "polygon", "polyline", "line",
  "g", "defs", "linearGradient", "radialgradient", "stop",
  "filter", "feturbulence", "fedisplacementmap", "fegaussianblur",
  "fecomponenttransfer", "fefunca",
  "text", "tspan", "symbol", "use",
]);

const BLOCKED_TAGS = new Set(["script", "foreignobject", "iframe", "embed", "object"]);

/** 检查 SVG 字符串是否安全。返回问题列表，空 = 安全。 */
export function sanitizeSvg(svg: string): string[] {
  const problems: string[] = [];

  // 检查危险标签
  const tagPattern = /<(\/?)([\w-]+)/gi;
  let match;
  while ((match = tagPattern.exec(svg)) !== null) {
    const tag = match[2].toLowerCase();
    if (BLOCKED_TAGS.has(tag)) {
      problems.push(`Blocked tag <${match[2]}>`);
    }
  }

  // 检查事件属性
  if (/\bon\w+\s*=/i.test(svg)) {
    problems.push("Event handler attributes (on*) are not allowed");
  }

  /*
   * 检查外链。允许两种：# 开头的内部引用，以及内联的**光栅** data URI。
   *
   * 放开 data URI 是因为这条规则的意图是「不许引用外部资源」，
   * 而 data: 是自包含的 —— 它既不发请求，也不会让同一份素材在不同环境下变样。
   * 画出来的火焰、拍出来的贴纸这类东西没法用路径表达，嵌一张位图是唯一的路。
   *
   * 但**只准光栅**：data:image/svg+xml 能套一层嵌套 SVG，而嵌套的那层不会被这个
   * 清洗器看到 —— 里面塞 script 就绕过去了。png / jpeg / webp 没有这个问题。
   */
  const RASTER_DATA_URI = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i;
  const hrefPattern = /(?:href|xlink:href)\s*=\s*["'](?!#)([^"']*)/gi;
  while ((match = hrefPattern.exec(svg)) !== null) {
    const v = match[1];
    if (!v || v.startsWith("#") || RASTER_DATA_URI.test(v)) continue;
    if (/^data:/i.test(v)) {
      problems.push(
        `Inline data URI must be a raster image (png/jpeg/webp/gif); ` +
          `data:image/svg+xml is rejected because a nested SVG bypasses this sanitizer: ${v.slice(0, 40)}`,
      );
    } else {
      problems.push(`External href not allowed: ${v.slice(0, 50)}`);
    }
  }

  // 检查 style 里的 url() 外链
  if (/url\s*\(\s*(?!['"]?#)/i.test(svg)) {
    problems.push("External url() references in styles are not allowed");
  }

  return problems;
}

/** 从 SVG 字符串提取 viewBox 的宽高比（height/width）。 */
export function extractAspect(svg: string): number {
  const vb = svg.match(/viewBox\s*=\s*["']([^"']+)["']/);
  if (vb) {
    const parts = vb[1].trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts[2] > 0) {
      return parts[3] / parts[2];
    }
  }
  // fallback: try width/height attributes
  const w = svg.match(/width\s*=\s*["']?(\d+)/);
  const h = svg.match(/height\s*=\s*["']?(\d+)/);
  if (w && h) return Number(h[1]) / Number(w[1]);
  return 1;
}
