import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { TemplateConfig, TemplateListing } from "@/engine/types";
import { TemplateError, checkWiring, validateTemplate } from "./validate";

/**
 * 模板清单。
 *
 * 目录里放一个 JSON 就是一个新模板 —— 不用改这个文件，不用加 import。
 * 这是「持续增加模板」的第一层：去掉改代码这一步。
 *
 * 第二层（新增模板不发版，PRD 4.6）是把 loadAll() 换成查 templates 表
 * 或者从 R2 拉清单。换的只有这个文件，API 和引擎都不用动。
 */

const DIR = path.join(process.cwd(), "src/content/templates");

type Raw = Record<string, unknown>;

function toConfig(r: Raw): TemplateConfig {
  const templateType = (r.template_type as TemplateConfig["templateType"]) ?? "particle";
  return {
    slug: r.slug as string,
    name: r.name as TemplateConfig["name"],
    category: r.category as string,
    priceCents: r.price_cents as number,
    preview: (r.preview ?? {}) as TemplateConfig["preview"],
    locked: false,
    templateType,
    perception: (r.perception ?? []) as TemplateConfig["perception"],
    emitter: r.emitter as unknown as TemplateConfig["emitter"],
    substance: r.substance as unknown as TemplateConfig["substance"],
    controls: (r.controls ?? []) as unknown as TemplateConfig["controls"],
    overlayElements: r.overlay_elements as unknown as TemplateConfig["overlayElements"],
    faceTrackElements: r.face_track_elements as unknown as TemplateConfig["faceTrackElements"],
    faceTrackAnimation: r.face_track_animation as unknown as TemplateConfig["faceTrackAnimation"],
  };
}

function loadAll(): Map<string, TemplateConfig> {
  const loaded: { order: number; cfg: TemplateConfig }[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    throw new Error(`读不到模板目录 ${DIR}：${(e as Error).message}`);
  }

  for (const file of files) {
    const full = path.join(DIR, file);
    let raw: Raw;
    try {
      raw = JSON.parse(fs.readFileSync(full, "utf8")) as Raw;
    } catch (e) {
      throw new TemplateError(file, [`JSON 解析失败：${(e as Error).message}`]);
    }

    const problems = validateTemplate(raw);
    if (problems.length) throw new TemplateError((raw.slug as string) ?? file, problems);

    const cfg = toConfig(raw);
    if (loaded.some((x) => x.cfg.slug === cfg.slug)) {
      throw new TemplateError(cfg.slug, [`slug 和之前某个模板重复了（${file}）`]);
    }

    const wiring = checkWiring(cfg);
    if (wiring.length) throw new TemplateError(cfg.slug, wiring);

    loaded.push({ order: (raw.sort_order as number) ?? 999, cfg });
  }

  // 展示顺序由 sort_order 决定，不是文件名字母序 ——
  // 字母序会把 coffee 排到 shower 前面，免费模板也不一定在最前。
  loaded.sort((a, b) => a.order - b.order || a.cfg.slug.localeCompare(b.cfg.slug));
  const out = new Map<string, TemplateConfig>(loaded.map(({ cfg }) => [cfg.slug, cfg]));

  // 一个都没读到必须炸。悄悄返回空清单的后果是线上一个模板都没有，
  // 而且看起来像「网站坏了」而不是「配置没打包进去」，排查方向全错。
  if (out.size === 0) {
    throw new Error(`${DIR} 里没有任何模板 JSON。如果是部署环境，检查这个目录有没有被打进产物`);
  }
  return out;
}

/**
 * 开发环境每次都重读，所以新扔一个 JSON 进去刷新页面就能看到，不用重启。
 * 生产环境读一次缓存住。
 */
const globalForTemplates = globalThis as unknown as { __templates?: Map<string, TemplateConfig> };
const isProd = process.env.NODE_ENV === "production";

function registry(): Map<string, TemplateConfig> {
  if (isProd) return (globalForTemplates.__templates ??= loadAll());
  return loadAll();
}

export function allTemplates(): TemplateConfig[] {
  return [...registry().values()];
}

export function getTemplate(slug: string): TemplateConfig | null {
  return registry().get(slug) ?? null;
}

export function isFree(slug: string): boolean {
  return (registry().get(slug)?.priceCents ?? 0) === 0;
}

/**
 * 列表视图：付费模板只给预览和价格，不给 config。
 *
 * 这是本产品最容易被白嫖的地方（PRD 4.4）——物理参数一旦进了前端 bundle，
 * 把它抄走就等于拿到了模板。所以完整配置只走 /api/templates/:slug/config，
 * 而且那个接口必须先查权益。
 */
export function toListing(t: TemplateConfig, unlocked: boolean): TemplateListing {
  return {
    slug: t.slug,
    name: t.name,
    category: t.category,
    priceCents: t.priceCents,
    preview: t.preview,
    locked: t.priceCents > 0 && !unlocked,
  };
}
