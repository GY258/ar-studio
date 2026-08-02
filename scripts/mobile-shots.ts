#!/usr/bin/env tsx
/**
 * 手机端流程截图。开发者本地手动跑，不进 CI。
 *
 * 存在的理由：这个项目主要在**手机上**用，而我一直只在 1280×800 的桌面视口下
 * 验证 —— 「翻转摄像头按钮只加进了桌面那一排、手机上根本看不到」这种问题
 * 因此漏到了线上。冒烟里那条手机视口检查只验「关键控件在不在」，
 * 验不了「好不好用」；好不好用得**把每一步拍下来看**。
 *
 * 用真的设备模拟（触摸 + DPR + 移动 UA），不是把窗口拉窄：
 * `pointer: coarse` 决定了引擎会走降级路径，窗口拉窄触发不了。
 *
 * 用法：npm run shots:mobile [slug ...]
 */

import { chromium, devices, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pngToY4m } from "./fake-camera";

const ROOT = process.cwd();
const OUT = path.join(ROOT, ".smoke/mobile");
const FIXTURES = path.join(ROOT, "test/fixtures");
const TEMPLATES = path.join(ROOT, "src/content/templates");
const READY_MS = 90_000;

/** 模板需要什么画面输入。喂错了永远检测不到，截图里就什么都没有 */
function inputFor(slug: string): "hands" | "front" | "body" {
  const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES, `${slug}.json`), "utf8"));
  const p = raw.perception;
  if (!Array.isArray(p)) return "front";
  if (p.includes("pose")) return "body";
  if (p.includes("hands")) return "hands";
  return "front";
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string, proc: ChildProcess) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`dev server 提前退出了（code ${proc.exitCode}）`);
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("dev server 起不来");
}

async function shoot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  .smoke/mobile/${name}.png`);
}

async function walkTemplate(browser: Browser, baseUrl: string, slug: string) {
  // iPhone 13 的描述里带 isMobile / hasTouch / DPR 3 —— 拉窄窗口是模拟不出来的
  const ctx = await browser.newContext({ ...devices["iPhone 13"], permissions: ["camera"] });
  const page = await ctx.newPage();
  console.log(`\n--- ${slug} ---`);

  await page.goto(`${baseUrl}/studio/${slug}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await shoot(page, `${slug}-1-进入`);

  await page.getByRole("button", { name: "Open camera" }).click({ timeout: READY_MS });
  await page.waitForFunction(() => Boolean((window as unknown as { __engine?: unknown }).__engine), {
    timeout: READY_MS,
  });
  // 等检测收敛，不然拍到的是「还没追上」的一帧
  await page.waitForTimeout(8000);
  await shoot(page, `${slug}-2-使用中`);

  // 0.5 档：iOS 只给横向流，竖屏 cover 之后只剩 26% 的宽度，
  // 往回缩才看得到接近系统相机那样的取景。这一张就是验它长什么样
  // 最低那一档现在是算出来的小数，名字不固定 —— 按位置取第一个缩放钮
  const half = page.locator("button:visible").filter({ hasText: /^0\.\d$/ });
  if (await half.count()) {
    await half.first().click();
    await page.waitForTimeout(800);
    await shoot(page, `${slug}-2b-缩到0.5`);
  }

  // 设置面板：手机上是从底部升起的抽屉
  const gear = page.locator("button").filter({ has: page.locator("svg") });
  const settings = page.getByRole("button", { name: /settings|设置/i });
  if (await settings.count()) {
    await settings.first().click();
  } else {
    // 没有可读的名字就点第一个带 svg 的圆钮（齿轮），顺便说明这本身就是个可用性问题
    await gear.first().click();
  }
  await page.waitForTimeout(600);
  await shoot(page, `${slug}-3-设置面板`);

  await ctx.close();
}

async function main() {
  const want = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const slugs = want.length ? want : ["fluidity", "soap-bubbles"];

  fs.mkdirSync(OUT, { recursive: true });
  const inputs = [...new Set(slugs.map(inputFor))];
  for (const input of inputs) {
    const src = path.join(FIXTURES, `${input}.png`);
    const dst = path.join(OUT, `${input}.y4m`);
    // 静态图会让「动作驱动」的效果全程读到 0，必须给点运动
    pngToY4m(src, dst, input === "front" ? { frames: 4 } : { frames: 45, panY: 0.22 });
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dev = spawn("npx", ["next", "dev", "-p", String(port)], {
    cwd: ROOT,
    env: { ...process.env, NEXT_DIST_DIR: ".next-shots" },
    stdio: "ignore",
  });
  try {
    await waitForServer(baseUrl, dev);
    for (const slug of slugs) {
      const input = inputFor(slug);
      const browser = await chromium.launch({
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          `--use-file-for-fake-video-capture=${path.join(OUT, `${input}.y4m`)}`,
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
        ],
      });
      try {
        await walkTemplate(browser, baseUrl, slug);
      } finally {
        await browser.close();
      }
    }
    console.log(`\n截图在 .smoke/mobile/`);
  } finally {
    dev.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
