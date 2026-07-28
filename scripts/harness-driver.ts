/**
 * 离线渲染 harness（Node 侧）：打包 + 起静态服务 + 开一个 chromium 页。
 *
 * render:preview 和 test:render 共用这一份，两条路走的渲染通路必须完全一样——
 * 否则「preview 看着对，test 却挂了」会变成常态，而 preview 是 LLM 唯一的眼睛。
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import esbuild from "esbuild";
import { chromium, type Browser, type Page } from "@playwright/test";
import { migrateElements } from "../src/lib/migrate";

// 全部入口都由 npm scripts 从仓库根跑，cwd 就是根
const ROOT = process.cwd();
const HARNESS_DIR = path.join(ROOT, "test/harness");
const FIXTURES_DIR = path.join(ROOT, "test/fixtures");

export const VIEWPORT = { width: 960, height: 540 };
export type FixtureName = "front" | "side" | "far" | "noface";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

/**
 * 把 harness 打成一个自包含 bundle。
 * 走 esbuild 而不是起 next dev：CI 里跑一次 next build 要几十秒，
 * 而这里要的只是把 src/engine 的 TS 变成浏览器能跑的 JS。
 */
async function buildBundle(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [path.join(HARNESS_DIR, "harness.ts")],
    bundle: true,
    format: "iife",
    target: "chrome110",
    write: false,
    // "@/..." 是 tsconfig 里的路径别名，esbuild 不读 tsconfig paths，这里显式给
    alias: { "@": path.join(ROOT, "src") },
    // src/lib/assets.ts 读 process.env 拿 CDN 地址。浏览器里没有 process，
    // 给个空壳让它走默认分支——离线渲染本来就不该去 CDN 拉东西。
    banner: { js: "globalThis.process ||= { env: {} };" },
    define: { "process.env.NODE_ENV": '"test"' },
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

export interface Harness {
  page: Page;
  close(): Promise<void>;
}

/**
 * 起 harness。
 *
 * 用本地 http 服务而不是 file://：fetch() 和 canvas.getImageData() 在 file://
 * 下会撞跨域/污染画布，mask 读不回来。
 */
export async function launchHarness(): Promise<Harness> {
  const bundle = await buildBundle();

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (url === "/harness.js") {
      res.writeHead(200, { "content-type": MIME[".js"] });
      res.end(bundle);
      return;
    }

    const file =
      url === "/" ? path.join(HARNESS_DIR, "harness.html")
      : url.startsWith("/fixtures/") ? path.join(FIXTURES_DIR, url.slice("/fixtures/".length))
      : null;

    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  let browser: Browser;
  try {
    browser = await chromium.launch({
      // headless chromium 默认没有 GPU，SwiftShader 软件渲染 WebGL。
      // 不开这两个开关会拿到一张纯黑的图，而且不报错。
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
  } catch (e) {
    server.close();
    throw new Error(
      `启动不了 chromium：${(e as Error).message}\n先跑一次 npx playwright install chromium`,
    );
  }

  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error(`[harness] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => Boolean((window as unknown as { harness?: unknown }).harness));

  return {
    page,
    async close() {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 装一个模板，返回展开后的元素数。 */
export async function loadTemplate(page: Page, templatePath: string, fixture: FixtureName) {
  const raw = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  await page.evaluate(
    async ([f, w, h]) =>
      window.harness.setup({ fixture: f as FixtureName, width: w as number, height: h as number }),
    [fixture, VIEWPORT.width, VIEWPORT.height] as const,
  );
  return page.evaluate((r) => window.harness.loadTemplate(r), raw);
}

/** 渲染指定时刻并返回 PNG buffer。 */
export async function capture(page: Page, t: number): Promise<Buffer> {
  const dataUrl = await page.evaluate((tt) => {
    window.harness.render(tt);
    return window.harness.snapshot();
  }, t);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

/**
 * 模板的整体周期。
 *
 * period 要从**转换展开之后**的元素上读：v1 模板的动画藏在 float / fall 里，
 * 没有 preset 字段，直接扫原始 JSON 会一个都扫不到，然后默默返回 1s，
 * 让「周期闭合」断言在一个毫无意义的时刻上跑。
 *
 * closes 表示这个 P 是不是真正的公共周期。周期两两互质时（雨滴有 20 多个
 * 不同 period）根本不存在可用的公倍数，这时只能诚实地说「闭合断言不适用」，
 * 而不是挑一个数字假装它闭合。
 */
export function templatePeriod(templatePath: string): { period: number; closes: boolean } {
  const raw = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  const elements = migrateElements(raw).elements;
  const periods = elements.flatMap((e) =>
    (e.animations ?? []).map((a) => (a as { period?: number }).period ?? 0).filter((p) => p > 0),
  );
  if (periods.length === 0) return { period: 1, closes: true };

  const uniq = [...new Set(periods)];
  const longest = Math.max(...uniq);
  const scale = 100; // period 是一两位小数的量级，放大成整数再求 lcm
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

  let lcm = Math.round(uniq[0] * scale);
  for (const p of uniq.slice(1)) {
    lcm = (lcm / gcd(lcm, Math.round(p * scale))) * Math.round(p * scale);
    if (!Number.isFinite(lcm) || lcm / scale > longest * 12) {
      return { period: longest, closes: false };
    }
  }
  return { period: lcm / scale, closes: true };
}

declare global {
  interface Window {
    harness: {
      setup(o: { fixture: string; width: number; height: number }): Promise<void>;
      loadTemplate(raw: unknown): Promise<number>;
      render(t: number): void;
      snapshot(): string;
    };
  }
}
