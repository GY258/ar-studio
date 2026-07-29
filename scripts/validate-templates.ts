#!/usr/bin/env tsx
/**
 * L0 · Schema 校验（毫秒级，无浏览器，无网络）
 *
 * 直接 import src/lib/validate.ts 里的 validateTemplate —— 不允许在这里手抄一份
 * 校验规则。之前这个脚本是 .mjs 里手写的第二套实现，跟 validate.ts 已经漂移了
 * （少了 asset/anchor/size 全部规则、少了生成器展开），而模板照样报「✓」。
 * 文档与代码漂移这件事已经发生过一次，不要在校验器上重演。
 *
 * 用法：
 *   npm run validate:templates                          # 全部模板
 *   npm run validate:templates -- src/content/templates/crying.json   # 单个文件
 */

import fs from "node:fs";
import path from "node:path";
import { validateTemplate } from "../src/lib/validate";
import { migrateElements } from "../src/lib/migrate";

const ROOT = process.cwd();
const TEMPLATES_DIR = path.join(ROOT, "src/content/templates");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const OFF = "\x1b[0m";

function targets(): string[] {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.length > 0) {
    for (const f of args) {
      if (!fs.existsSync(f)) {
        console.error(`${RED}找不到文件：${f}${OFF}`);
        process.exit(1);
      }
    }
    return args;
  }
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(TEMPLATES_DIR, f));
}

let failed = false;

for (const file of targets()) {
  const name = path.basename(file);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`${RED}✗${OFF} ${name}\n    JSON 解析失败：${(e as Error).message}`);
    failed = true;
    continue;
  }

  const problems = validateTemplate(raw);

  if (problems.length > 0) {
    console.error(`${RED}✗${OFF} ${name}`);
    for (const p of problems) console.error(`    ${p}`);
    failed = true;
    continue;
  }

  // 展开信息：元素数和兼容层触发情况一起报出来，
  // 「校验过了但什么都看不见」多半在这一行就能看出苗头。
  const { elements, warnings } = migrateElements(raw);
  // 「无元素」有两种：particle 模板本来就不用元素，只有帧效果的模板也不用。
  // 一律写「particle 模板」会把 colorful-me 这类说成另一个类型，看着像出错了。
  const detail =
    elements.length > 0
      ? `${DIM}${elements.length} 个元素${OFF}`
      : raw.source
        ? `${DIM}无元素（只有帧效果）${OFF}`
        : `${DIM}无元素（particle 模板）${OFF}`;
  console.log(`${GREEN}✓${OFF} ${name}  ${detail}`);
  for (const w of warnings) {
    console.log(`    ${YELLOW}compat${OFF} ${w}`);
  }
}

process.exit(failed ? 1 : 0);
