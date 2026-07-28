#!/usr/bin/env node
/**
 * L0 · Schema 校验（无浏览器，毫秒级）
 *
 * 对 src/content/templates/*.json 全量跑 validateTemplate。
 * 任何一个失败 → 退出码 1，stderr 打出全部问题。
 *
 * 用法：
 *   npm run validate:templates                    # 全部模板
 *   npm run validate:templates -- path/to/file.json  # 单个文件
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(ROOT, "src/content/templates");

// 动态导入 validate（TS 文件需要通过 tsx 或构建后运行）
// 这里直接解析 JSON 做基础校验，不依赖 TS 编译
function validateTemplateBasic(raw) {
  const p = [];
  const TEMPLATE_TYPES = ["particle", "overlay", "facetrack"];
  const ANCHOR_NAMES = [
    "lower_eyelid_left", "lower_eyelid_right", "upper_eyelid_left", "upper_eyelid_right",
    "eye_outer_left", "eye_outer_right", "iris_left", "iris_right",
    "nose_bridge", "nose_tip", "forehead", "head_top", "chin", "mouth_center",
    "upper_lip", "lower_lip", "cheek_left", "cheek_right",
    "temple_left", "temple_right", "jaw_left", "jaw_right", "ear_left", "ear_right",
  ];
  const ANIM_PRESETS = ["float", "fall", "pulse", "spin", "emit-fall-fade"];

  // 基础字段
  if (typeof raw.slug !== "string" || !/^[a-z0-9-]+$/.test(raw.slug))
    p.push("slug 必须是小写字母、数字、连字符");
  if (!raw.name?.zh) p.push("name.zh 必填");
  if (typeof raw.category !== "string") p.push("category 必填");
  if (typeof raw.price_cents !== "number" || raw.price_cents < 0)
    p.push("price_cents 必须是 ≥0 的数字");

  const type = raw.template_type || "particle";
  if (!TEMPLATE_TYPES.includes(type))
    p.push(`template_type "${type}" 无效，可选：${TEMPLATE_TYPES.join(", ")}`);

  // overlay
  if (type === "overlay") {
    const elems = raw.overlay_elements;
    if (!Array.isArray(elems) || elems.length === 0)
      p.push("overlay 类型需要 overlay_elements 数组");
    else if (elems.length > 120)
      p.push(`overlay_elements 有 ${elems.length} 个，上限 120`);
    else {
      const ids = new Set();
      for (const [i, e] of elems.entries()) {
        const at = `overlay_elements[${i}]`;
        if (!e.id) p.push(`${at}.id 必填`);
        else if (ids.has(e.id)) p.push(`${at}.id "${e.id}" 重复`);
        else ids.add(e.id);
        if (typeof e.nx !== "number") p.push(`${at}.nx 必须是数字`);
        if (typeof e.sizeW !== "number" || e.sizeW <= 0 || e.sizeW > 1) p.push(`${at}.sizeW 应在 (0,1]`);
        if (e.animations) validateAnims(e.animations, at, p, ANIM_PRESETS);
      }
    }
  }

  // facetrack
  if (type === "facetrack") {
    const elems = raw.face_track_elements;
    if (!Array.isArray(elems) || elems.length === 0)
      p.push("facetrack 类型需要 face_track_elements 数组");
    else if (elems.length > 120)
      p.push(`face_track_elements 有 ${elems.length} 个，上限 120`);
    else {
      const ids = new Set();
      for (const [i, e] of elems.entries()) {
        const at = `face_track_elements[${i}]`;
        if (!e.id) p.push(`${at}.id 必填`);
        else if (ids.has(e.id)) p.push(`${at}.id "${e.id}" 重复`);
        else ids.add(e.id);
        if (e.landmark !== undefined) {
          if (typeof e.landmark === "string" && !ANCHOR_NAMES.includes(e.landmark))
            p.push(`${at}.landmark "${e.landmark}" 不在锚点表里。可选：${ANCHOR_NAMES.slice(0, 6).join(", ")}…`);
          if (typeof e.landmark === "number" && (e.landmark < 0 || e.landmark > 477))
            p.push(`${at}.landmark ${e.landmark} 超出 0~477`);
        }
        if (e.iodScale !== undefined && (typeof e.iodScale !== "number" || e.iodScale <= 0 || e.iodScale > 3))
          p.push(`${at}.iodScale 应在 (0, 3]`);
        if (e.animations) validateAnims(e.animations, at, p, ANIM_PRESETS);
      }
    }
  }

  // particle
  if (type === "particle") {
    if (!raw.emitter) p.push("particle 类型需要 emitter");
    if (!raw.substance) p.push("particle 类型需要 substance");
    if (!Array.isArray(raw.controls) || raw.controls.length === 0) p.push("particle 类型需要 controls 数组");
  }

  return p;
}

function validateAnims(anims, at, p, presets) {
  for (const [i, a] of anims.entries()) {
    if (!a.preset || !presets.includes(a.preset))
      p.push(`${at}.animations[${i}].preset 无效，可选：${presets.join(", ")}`);
    if (a.period !== undefined && (typeof a.period !== "number" || a.period <= 0))
      p.push(`${at}.animations[${i}].period 必须是正数`);
  }
}

// --- 主逻辑 ---
const args = process.argv.slice(2);
let files;

if (args.length > 0 && args[0] !== "--") {
  const target = args[args.length - 1];
  if (!fs.existsSync(target)) {
    console.error(`File not found: ${target}`);
    process.exit(1);
  }
  files = [target];
} else {
  files = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => path.join(TEMPLATES_DIR, f));
}

let failed = false;

for (const file of files) {
  const name = path.basename(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`\x1b[31m✗\x1b[0m ${name}: JSON 解析失败 — ${e.message}`);
    failed = true;
    continue;
  }

  const problems = validateTemplateBasic(raw);
  if (problems.length > 0) {
    console.error(`\x1b[31m✗\x1b[0m ${name}`);
    for (const p of problems) console.error(`    ${p}`);
    failed = true;
  } else {
    console.log(`\x1b[32m✓\x1b[0m ${name}`);
  }
}

process.exit(failed ? 1 : 0);
