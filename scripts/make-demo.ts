#!/usr/bin/env tsx
/**
 * 用一张照片给主页做示例片段：照片 → 真跑一次 MediaPipe → 套模板逐帧渲染 → mp4。
 *
 * 走的是 render:preview 同一条离线渲染通路，所以出来的效果就是引擎真实的样子，
 * 不是另外 P 的图。照片本身是静止的，动的只有效果 —— 依赖「人在动」的模板
 * （fluidity 的节奏、弯手指长茎）在这里不会有它们在真摄像头上的表现。
 *
 * 照片是用户本人的，**不进仓库**：录制产物和中间帧都放在 .demo-work/（已 gitignore），
 * 只有最终的 mp4 / jpg 写进 public/demos/。
 *
 * 用法：
 *   npm run make:demo -- <照片> <模板 slug> [<模板 slug> ...] [--seconds 6] [--name gary]
 *
 * 需要外网（录制要下 MediaPipe 模型）和 ffmpeg。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launchHarness, loadTemplate, capture, type FixtureName } from "./harness-driver";

const ROOT = process.cwd();
const WORK = path.join(ROOT, ".demo-work");
const OUT = path.join(ROOT, "public/demos");
const TEMPLATES = path.join(ROOT, "src/content/templates");

// 竖屏 9:16，和用户在手机上拍出来的一致；720p 够主页卡片用，文件也小
const SIZE = { width: 720, height: 1280 };
const FPS = 30;

function parseArgs() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  let seconds = 6;
  let name = "";
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seconds") seconds = Number(argv[++i]);
    else if (argv[i] === "--name") name = argv[++i];
    else rest.push(argv[i]);
  }
  const [photo, ...slugs] = rest;
  if (!photo || slugs.length === 0) {
    console.error("用法：npm run make:demo -- <照片> <模板 slug> [...] [--seconds 6] [--name gary]");
    process.exit(1);
  }
  if (!fs.existsSync(photo)) {
    console.error(`找不到照片：${photo}`);
    process.exit(1);
  }
  for (const slug of slugs) {
    if (!fs.existsSync(path.join(TEMPLATES, `${slug}.json`))) {
      console.error(`没有这个模板：${slug}（看 src/content/templates/）`);
      process.exit(1);
    }
  }
  // fixture 名只用安全字符，它会拼进 URL 和文件名
  name ||= path.basename(photo, path.extname(photo)).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { photo: path.resolve(photo), slugs, seconds, name };
}

/**
 * 照片转成 PNG 并裁成 9:16。
 * 用 macOS 自带的 sips：HEIC 也吃，不用多装依赖；裁剪交给 ffmpeg 的 crop 更好控。
 */
function preparePhoto(photo: string, dest: string) {
  const tmp = path.join(WORK, "src.png");
  execFileSync("sips", ["-s", "format", "png", photo, "--out", tmp], { stdio: "ignore" });
  // 先 cover 到 720x1280 再居中裁 —— 和 studio 里 object-fit: cover 的取景一致
  execFileSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error", "-i", tmp,
      "-vf", `scale=${SIZE.width}:${SIZE.height}:force_original_aspect_ratio=increase,crop=${SIZE.width}:${SIZE.height}`,
      dest,
    ],
  );
  fs.rmSync(tmp);
}

async function main() {
  const { photo, slugs, seconds, name } = parseArgs();
  const fixtures = path.join(WORK, "fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  preparePhoto(photo, path.join(fixtures, `${name}.png`));
  console.log(`照片 → .demo-work/fixtures/${name}.png`);

  // 录 landmark / 蒙版 / 手 / 姿态。复用 record:fixture，只是把目录指到仓库外
  execFileSync("npx", ["tsx", "scripts/record-fixture.ts", name], {
    stdio: "inherit",
    env: { ...process.env, AR_FIXTURES_DIR: fixtures },
  });

  const harness = await launchHarness(SIZE, fixtures);
  try {
    for (const slug of slugs) {
      const frames = path.join(WORK, "frames", `${name}-${slug}`);
      fs.rmSync(frames, { recursive: true, force: true });
      fs.mkdirSync(frames, { recursive: true });

      await loadTemplate(harness.page, path.join(TEMPLATES, `${slug}.json`), name as FixtureName, SIZE);
      const total = Math.round(seconds * FPS);
      for (let i = 0; i < total; i++) {
        const png = await capture(harness.page, i / FPS);
        fs.writeFileSync(path.join(frames, `${String(i).padStart(4, "0")}.png`), png);
      }

      const base = path.join(OUT, slug);
      execFileSync("ffmpeg", [
        "-y", "-loglevel", "error",
        "-framerate", String(FPS), "-i", path.join(frames, "%04d.png"),
        // yuv420p + faststart：iOS Safari 才肯内联自动播放，而且不用下完就能开始播
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow",
        "-movflags", "+faststart", "-an",
        `${base}.mp4`,
      ]);
      // poster 取第 1 秒：t=0 时很多效果还没进场，拿它当封面是一张白板
      const posterFrame = Math.min(total - 1, FPS);
      execFileSync("ffmpeg", [
        "-y", "-loglevel", "error",
        "-i", path.join(frames, `${String(posterFrame).padStart(4, "0")}.png`),
        "-q:v", "4", `${base}.jpg`,
      ]);

      const kb = (fs.statSync(`${base}.mp4`).size / 1024).toFixed(0);
      console.log(`✓ ${slug}  →  public/demos/${slug}.mp4 (${kb} KB) + .jpg`);
    }
  } finally {
    await harness.close();
  }

  console.log(
    `\n把新片段加进 src/lib/demos.ts：\n` +
      slugs.map((s) => `  { template: "${s}", video: "/demos/${s}.mp4", poster: "/demos/${s}.jpg" },`).join("\n"),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
