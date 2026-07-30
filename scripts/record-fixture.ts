#!/usr/bin/env tsx
/**
 * 录制 fixture：对 test/fixtures/<name>.png 真跑一次 MediaPipe，
 * 把 478 点 landmark 和分割置信度固化成文件提交进仓库。
 *
 * **只有开发者本地手动跑，绝不进 CI。** 它需要下载模型（走 jsdelivr，国内不通）
 * 和一块能跑 GPU delegate 的机器。CI 回放的是这一步的产物。
 *
 * 先把真人照片放成 test/fixtures/front.png / side.png / far.png / noface.png / hands.png，
 * 再跑这个脚本覆盖同名的 .landmarks.json 和 .mask.png。
 * 没有真人照片时用 scripts/make-fixtures.ts 生成的合成脸，链路一样能跑通。
 * 现在仓库里的是图库照片派生的真人 fixture，来源和裁法见 test/fixtures/CREDITS.md。
 *
 * 用法：npm run record:fixture [-- front side]
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import esbuild from "esbuild";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";

const ROOT = process.cwd();
const FIXTURES = path.join(ROOT, "test/fixtures");
const DEFAULT_NAMES = ["front", "side", "far", "noface", "hands"];

interface Recorded {
  landmarks: { x: number; y: number; z: number }[] | null;
  mask: { data: number[]; w: number; h: number } | null;
  hands: { hand: "left" | "right"; points: { x: number; y: number; z: number }[] }[] | null;
}

async function main() {
  const names = process.argv.slice(2).filter((a) => a !== "--");
  const targets = (names.length ? names : DEFAULT_NAMES).filter((n) => {
    const ok = fs.existsSync(path.join(FIXTURES, `${n}.png`));
    if (!ok) console.warn(`跳过 ${n}：找不到 test/fixtures/${n}.png`);
    return ok;
  });
  if (targets.length === 0) {
    console.error("没有可录的输入图。先把照片放进 test/fixtures/<name>.png");
    process.exit(1);
  }

  const bundle = await esbuild.build({
    entryPoints: [path.join(ROOT, "test/harness/record.ts")],
    bundle: true,
    format: "iife",
    target: "chrome110",
    write: false,
    alias: { "@": path.join(ROOT, "src") },
    banner: { js: "globalThis.process ||= { env: {} };" },
    logLevel: "silent",
  });

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/record.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end(bundle.outputFiles[0].text);
      return;
    }
    if (url === "/") {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`<!doctype html><meta charset="utf-8"><script src="/record.js"></script>`);
      return;
    }
    const file = path.join(FIXTURES, url.replace(/^\/fixtures\//, ""));
    if (!fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "image/png" }).end(fs.readFileSync(file));
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  // 录制必须联网：这一步就是要真跑模型。CI 不跑它，所以这里不做离线兜底。
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error(`[record] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`);

  try {
    await page.evaluate(() => (window as unknown as { recorder: { load(): Promise<void> } }).recorder.load());
  } catch (e) {
    await browser.close();
    server.close();
    console.error(`MediaPipe 模型加载失败：${(e as Error).message}`);
    console.error("这一步需要外网。国内环境 jsdelivr 常不通，挂代理或换 WASM_BASE。");
    process.exit(1);
  }

  for (const name of targets) {
    const rec = (await page.evaluate(
      (n) => (window as unknown as { recorder: { record(s: string): Promise<Recorded> } }).recorder.record(`/fixtures/${n}.png`),
      name,
    )) as Recorded;

    fs.writeFileSync(
      path.join(FIXTURES, `${name}.landmarks.json`),
      JSON.stringify(rec.landmarks) + "\n",
    );

    if (rec.mask) {
      const png = new PNG({ width: rec.mask.w, height: rec.mask.h });
      for (let i = 0; i < rec.mask.data.length; i++) {
        // provider 给的是 0~1 的置信度，存成 8bit 灰度。
        // 忘了乘 255 的话整张蒙版会变成纯黑，而且是「跑完没报错、下游全静默失效」那种
        const v = Math.round(Math.min(1, Math.max(0, rec.mask.data[i])) * 255);
        png.data[i * 4] = v;
        png.data[i * 4 + 1] = v;
        png.data[i * 4 + 2] = v;
        png.data[i * 4 + 3] = 255;
      }
      fs.writeFileSync(path.join(FIXTURES, `${name}.mask.png`), PNG.sync.write(png));
    }

    // 手部单独一个文件。没检测到手就不写 —— 空文件和「这张 fixture 本来就没手」
    // 分不开，而 harness 靠文件存不存在决定要不要注入 provider
    const handsFile = path.join(FIXTURES, `${name}.hands.json`);
    if (rec.hands?.length) {
      fs.writeFileSync(handsFile, JSON.stringify(rec.hands));
    } else if (fs.existsSync(handsFile)) {
      fs.rmSync(handsFile);
    }

    console.log(
      `✓ ${name}  landmark ${rec.landmarks ? `${rec.landmarks.length} 点` : "无"}，` +
        `mask ${rec.mask ? `${rec.mask.w}x${rec.mask.h}` : "无"}`,
        `hands ${rec.hands?.length ? `${rec.hands.length} 只（${rec.hands.map((h) => h.hand).join("/")}）` : "无"}`,
    );
  }

  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  console.log("\n录好了。记得把 fixture 一起提交，并重新生成 golden：npm run test:render -- --update-golden");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
