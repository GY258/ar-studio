#!/usr/bin/env tsx
/**
 * 把 src/content/fonts/nunito-latin.woff2 打包成 src/engine/font-data.ts 的 base64 常量。
 *
 * 为什么要打包成字符串而不是放 public/：离线 harness 的那个小 http 服务只伺候
 * /harness.js 和 /fixtures/*，字体走额外请求就是 404，「断网也能跑」这条就破了。
 * 和 SVG 素材同一个理由、同一个做法。
 *
 * 用法：npm run gen:font
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src/content/fonts/nunito-latin.woff2");
const OUT = path.join(ROOT, "src/engine/font-data.ts");

const raw = fs.readFileSync(SRC);
if (raw.subarray(0, 4).toString() !== "wOF2") {
  throw new Error(`${SRC} 不是 woff2（magic 应该是 wOF2）。别把 ttf 直接改后缀丢进来`);
}

const b64 = raw.toString("base64");
const lines = (b64.match(/.{1,100}/g) ?? []).map((c) => `  "${c}" +`);
lines[lines.length - 1] = lines[lines.length - 1].replace(/ \+$/, "");

const header = fs.readFileSync(OUT, "utf8").split("export const")[0];
fs.writeFileSync(OUT, `${header}export const NUNITO_LATIN_WOFF2_BASE64 =\n${lines.join("\n")};\n`);

console.log(`${path.relative(ROOT, OUT)}  ${(b64.length / 1024) | 0} KB base64（源文件 ${(raw.length / 1024) | 0} KB）`);
