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

  // 检查外链（只允许 # 开头的内部引用）
  const hrefPattern = /(?:href|xlink:href)\s*=\s*["'](?!#)([^"']*)/gi;
  while ((match = hrefPattern.exec(svg)) !== null) {
    if (match[1] && !match[1].startsWith("#")) {
      problems.push(`External href not allowed: ${match[1].slice(0, 50)}`);
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
