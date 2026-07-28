#!/usr/bin/env tsx
/**
 * 渲染一帧模板到 PNG，不做任何对比。
 *
 * 这条命令是 ar-template skill 的核心：它让「写模板」从盲写变成所见即所得。
 * 校验通过只说明结构合法，不说明看起来对——「校验过了但什么都看不见」是
 * 最常见的失败，只有把图打开看才能发现。
 *
 * 用法：
 *   npm run render:preview -- src/content/templates/crying.json
 *   npm run render:preview -- src/content/templates/crying.json --t 1.4
 *   npm run render:preview -- src/content/templates/crying.json --fixture side
 */

import fs from "node:fs";
import path from "node:path";
import { launchHarness, loadTemplate, capture, type FixtureName } from "./harness-driver";

const FIXTURES: FixtureName[] = ["front", "side", "far", "noface"];

function parseArgs() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  let t = 0;
  let fixture: FixtureName = "front";
  const files: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--t") t = Number(argv[++i]);
    else if (a === "--fixture") fixture = argv[++i] as FixtureName;
    else files.push(a);
  }

  if (files.length === 0) {
    console.error("用法：npm run render:preview -- <模板.json> [--t 秒] [--fixture front|side|far|noface]");
    process.exit(1);
  }
  if (!FIXTURES.includes(fixture)) {
    console.error(`--fixture "${fixture}" 不认识，可选：${FIXTURES.join(" / ")}`);
    process.exit(1);
  }
  if (!Number.isFinite(t)) {
    console.error("--t 必须是数字（秒）");
    process.exit(1);
  }
  return { files, t, fixture };
}

async function main() {
  const { files, t, fixture } = parseArgs();
  const outDir = path.join(process.cwd(), ".preview");
  fs.mkdirSync(outDir, { recursive: true });

  const harness = await launchHarness();
  try {
    for (const file of files) {
      if (!fs.existsSync(file)) {
        console.error(`找不到 ${file}`);
        process.exitCode = 1;
        continue;
      }
      const slug = path.basename(file, ".json");
      const count = await loadTemplate(harness.page, file, fixture);
      const png = await capture(harness.page, t);

      const suffix = fixture === "front" ? "" : `-${fixture}`;
      const out = path.join(outDir, `${slug}-t${t}${suffix}.png`);
      fs.writeFileSync(out, png);

      console.log(`${path.relative(process.cwd(), out)}  (${count} 个元素, t=${t}, fixture=${fixture})`);
      if (count === 0) {
        console.log("  注意：展开后 0 个元素，这张图上不会有任何贴纸");
      }
    }
  } finally {
    await harness.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
