#!/usr/bin/env tsx
/**
 * 从源码生成 ar-template skill 的 reference。
 *
 * 四份 reference 一律生成，不许手写：手写的那一刻就开始和代码漂移，
 * 而 JSON-MODE.md 与代码漂移这件事在这个仓库里已经发生过一次了。
 * SKILL.md 和 gotchas.md 是手写的——那两份讲的是「怎么做」和「踩过的坑」，
 * 不是类型定义，从源码生不出来。
 *
 * reference 提交进仓库（Claude Code 不用先跑生成脚本就能读），
 * 代价是 CI 里要有一条漂移检查，见 .github/workflows/templates.yml。
 *
 * 用法：npm run gen:skill-reference
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildSchemaReference,
  buildAssetIndex,
  buildAnchorReference,
  buildExamples,
} from "../src/lib/template-prompt";

const ROOT = process.cwd();
const OUT = path.join(ROOT, ".claude/skills/ar-template/reference");
const TEMPLATES = path.join(ROOT, "src/content/templates");

const HEADER = "<!-- 由 npm run gen:skill-reference 从源码生成，不要手改 -->\n\n";

/** few-shot 用哪几个模板。挑覆盖面广的，不要全塞进去。 */
const EXAMPLE_SLUGS = ["crying", "lowres-life", "emotions"];

function examples() {
  return EXAMPLE_SLUGS.map((slug) => ({
    slug,
    json: fs.readFileSync(path.join(TEMPLATES, `${slug}.json`), "utf8"),
  }));
}

const files: Record<string, string> = {
  "schema.md": `# 模板 Schema\n\n${buildSchemaReference()}`,
  "anchors.md": `# 人脸锚点\n\n${buildAnchorReference()}`,
  "assets.md": `# SVG 素材清单\n\n${buildAssetIndex()}`,
  "examples.md": `# 模板示例\n\n${buildExamples(examples())}`,
};

fs.mkdirSync(OUT, { recursive: true });

for (const [name, body] of Object.entries(files)) {
  const target = path.join(OUT, name);
  const content = HEADER + body.trimEnd() + "\n";
  const changed = !fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content;
  fs.writeFileSync(target, content);
  console.log(`${changed ? "✎" : "·"} ${path.relative(ROOT, target)}`);
}

console.log("\n手写的两份没有被覆盖：SKILL.md、reference/gotchas.md");
