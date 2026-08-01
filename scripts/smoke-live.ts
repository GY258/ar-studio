#!/usr/bin/env tsx
/**
 * L3 · 真链路冒烟。
 *
 * 起真的 dev server，用假摄像头喂 fixture，**真的从 CDN 下 MediaPipe 模型**，
 * 逐个模板开摄像头、截图、报 fps、抓 pageerror。
 *
 * 为什么需要它：L2（test:render）走的是注入的 fixture provider，
 * 覆盖不到「真模型能不能加载」「Next 路由通不通」「感知分发有没有接上」这一整类问题。
 * 这类问题已经漏过两次 —— hands 感知曾经是个静默失效的枚举值，
 * 而 blur 曾经能过校验、能渲染、什么都不做。**离线断言对它们完全免疫。**
 *
 * 所以这条不是「锦上添花的手工验证」，是一条命令：
 *
 *   npm run smoke:live                  # 全部模板
 *   npm run smoke:live -- crying cloud  # 只跑指定的
 *
 * **要联网**（下模型），所以和 record:fixture 一样不进 CI。
 * CI 里跑它等于把「国内不通」那条坑搬进流水线。
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, devices, type Browser } from "@playwright/test";
import { PNG } from "pngjs";
import { pngToY4m } from "./fake-camera";

const ROOT = process.cwd();
const TEMPLATES = path.join(ROOT, "src/content/templates");
const FIXTURES = path.join(ROOT, "test/fixtures");
const OUT = path.join(ROOT, ".smoke");

/** 每个模板等多久算「起来了」。SwiftShader + 两个模型的最坏情况 */
const READY_TIMEOUT_MS = 90_000;
/** 开摄像头之后再跑多久才截图。要留够时间让检测收敛 + fps 统计出第一个数 */
const SETTLE_MS = 8_000;

interface Result {
  slug: string;
  input: string;
  ok: boolean;
  fps: number | null;
  tracking: boolean | null;
  problems: string[];
}

/** 模板需要什么画面输入。喂错了永远检测不到，冒烟会「过了但什么都没验到」 */
function inputFor(raw: Record<string, unknown>): "hands" | "front" | "body" {
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

async function waitForServer(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server 在 ${timeoutMs}ms 内没起来：${url}`);
}

/**
 * 画面是不是空的。
 *
 * 「起来了但画了一张纯色」是这条链路上最典型的失效（shader 编译失败 → 材质变黑、
 * 模型没加载 → 一片空白），而它不抛任何错。只看有没有 pageerror 会全部放过。
 */
function frameLooksBlank(buf: Buffer): boolean {
  const img = PNG.sync.read(buf);
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4 * 37) {
    const lum = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    sum += lum;
    sum2 += lum * lum;
    n++;
  }
  const variance = sum2 / n - (sum / n) ** 2;
  return variance < 30;
}

/** 模板 JSON 里声明了多少个元素。装上的比声明的少，说明有东西被静默跳过了 */
function declaredElementCount(slug: string): number {
  const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES, `${slug}.json`), "utf8"));
  const els = raw.elements ?? raw.overlay_elements ?? raw.face_track_elements;
  // 有生成器的模板展开后数量会变多，这里只做「不少于平铺声明数」的下界检查
  return Array.isArray(els) ? els.filter((e: Record<string, unknown>) => !e.generate).length : 0;
}

/**
 * 手机端专项：**真的设备模拟**下验两件事。
 *
 * 一、关键控件在不在。翻转摄像头按钮曾经只加进了桌面那一排（`hidden md:flex`），
 *     手机版底部条是另一段 JSX —— 手机上根本没有入口，而那是唯一需要它的设备。
 * 二、开摄像头时**请求的约束**是不是竖向的。
 *
 * 第二条是这次想明白的：假摄像头会强制流的尺寸等于文件尺寸，
 * 所以「请求了竖向分辨率」在画面上**看不出任何区别** —— 我一度以为这只能真机验。
 * 但真正该验的不是拿到了什么画面，而是**请求了什么**：浏览器兑不兑现是操作系统的事，
 * 我们能控制的只有请求。把 getUserMedia 包一层记下参数就验到了，还能进 CI。
 *
 * 必须用 devices 描述而不是 setViewportSize：引擎按 `pointer: coarse` 判断是不是
 * 手机，拉窄窗口触发不到那条分支。
 */
async function checkMobile(browser: Browser, baseUrl: string, slug: string): Promise<string[]> {
  const problems: string[] = [];
  const ctx = await browser.newContext({ ...devices["iPhone 13"], permissions: ["camera"] });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as unknown as { __gum?: unknown[] }).__gum = [];
    navigator.mediaDevices.getUserMedia = (c?: MediaStreamConstraints) => {
      (window as unknown as { __gum: unknown[] }).__gum.push(c?.video);
      return orig(c);
    };
  });
  try {
    await page.goto(`${baseUrl}/studio/${slug}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Open camera" }).click({ timeout: READY_TIMEOUT_MS });
    await page.waitForTimeout(3000);

    for (const label of ["Flip camera"]) {
      const n = await page.getByRole("button", { name: label }).count();
      const visible = n > 0 && (await page.getByRole("button", { name: label }).first().isVisible());
      if (!visible) problems.push(`手机上找不到「${label}」按钮 —— 多半只加进了桌面那一排`);
    }

    const calls = (await page.evaluate(() => (window as unknown as { __gum: unknown[] }).__gum)) as {
      width?: { ideal?: number };
      height?: { ideal?: number };
    }[];
    const v = calls.find((c) => c && c.width && c.height);
    if (!v) {
      problems.push("没有捕获到 getUserMedia 的视频约束 —— 摄像头这条路可能压根没走到");
    } else {
      const w = v.width?.ideal ?? 0;
      const h = v.height?.ideal ?? 0;
      if (h <= w) {
        problems.push(
          `手机上请求的是横向分辨率 ${w}×${h} —— 竖屏画布会把两侧裁掉一大半，全身模板框不进人`,
        );
      }
    }
  } catch (e) {
    problems.push(`手机端检查失败：${(e as Error).message.split("\n")[0]}`);
  }
  await ctx.close();
  return problems;
}

async function runGroup(
  browser: Browser,
  baseUrl: string,
  slugs: string[],
  input: string,
): Promise<Result[]> {
  const out: Result[] = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["camera"] });


  for (const slug of slugs) {
    const problems: string[] = [];
    const page = await ctx.newPage();
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      const t = m.text();
      // three 的 shader 编译失败只在 console 里，不抛异常
      if (/GLSL|shader|WebGL: INVALID/i.test(t)) problems.push(`console: ${t.slice(0, 200)}`);
    });

    const declaredElements = declaredElementCount(slug);
    let fps: number | null = null;
    let tracking: boolean | null = null;
    try {
      const res = await page.goto(`${baseUrl}/studio/${slug}`, { waitUntil: "domcontentloaded" });
      if (!res || res.status() !== 200) problems.push(`路由返回 ${res?.status() ?? "无响应"}`);

      await page.getByRole("button", { name: "Open camera" }).click({ timeout: READY_TIMEOUT_MS });
      await page.waitForFunction(() => Boolean((window as unknown as { __engine?: unknown }).__engine), {
        timeout: READY_TIMEOUT_MS,
      });
      await page.waitForTimeout(SETTLE_MS);

      const stats = (await page.evaluate(() =>
        (
          window as unknown as {
            __engine: {
              debugStats(): {
                fps: number;
                tracking: boolean;
                needsTracking: boolean;
                elementCount: number;
                missingAssets: string[];
              };
            };
          }
        ).__engine.debugStats(),
      )) as {
        fps: number;
        tracking: boolean;
        needsTracking: boolean;
        elementCount: number;
        missingAssets: string[];
      };
      if (stats.missingAssets.length) {
        problems.push(`有元素的素材解不出来（静默跳过了）：${stats.missingAssets.join("；")}`);
      }
      if (declaredElements > 0 && stats.elementCount < declaredElements) {
        problems.push(`模板声明了 ${declaredElements} 个元素，只装上了 ${stats.elementCount} 个`);
      }
      fps = stats.fps;
      /*
       * fps 读到 0 先隔一秒再读一次，取大的。
       *
       * 这个数是「最近一段时间画了几帧」，而这台机器上冒烟是串行跑十几个模板、
       * 每个都在 SwiftShader 上软渲染两个模型 —— rAF 被饿一秒就是真的 0。
       * 单次瞬时读数下 `glass` 报过一次 fps=0，单独重跑两次都是 20，
       * 截图里杯子、倒液、堆积全都在。也就是说这个断言会**因为机器负载误报**，
       * 而冒烟一旦开始误报，下次真出问题时我会先怀疑是抖动 —— 那它就废了。
       *
       * 重读一次而不是放宽阈值：真的停了的话（shader 没编过、异常打断循环）
       * 第二次读还是 0，该抓的照样抓得到。
       */
      if (fps <= 0) {
        await page.waitForTimeout(1_000);
        const again = (await page.evaluate(() =>
          (window as unknown as { __engine: { debugStats(): { fps: number } } }).__engine.debugStats(),
        )) as { fps: number };
        fps = Math.max(fps, again.fps);
      }
      // 不需要感知的模板（纯屏幕空间贴纸）没有东西可追，别对它断言
      tracking = stats.needsTracking ? stats.tracking : null;

      const shot = await page.locator("canvas").first().screenshot();
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, `${slug}.png`), shot);

      /*
       * 手机视口下关键控件必须还在。
       *
       * 这条堵的是一类真踩过的失效：翻转摄像头按钮只加进了**桌面**那一排
       * （`hidden md:flex`），手机版的底部条是另一段 JSX —— 手机上根本没有入口。
       * 而全身类模板非后置不可，笔记本又只有前置，等于那个功能在唯一需要它的
       * 设备上不存在。桌面视口下的冒烟一路全绿。
       *
       * 只在第一个模板上验一次：这是全局 UI，每个模板都测一遍纯属浪费。
       */
      if (fps <= 0) problems.push("fps 为 0，渲染循环没在跑");
      if (frameLooksBlank(shot)) problems.push("画面几乎是纯色 —— 大概率 shader 没编过或模型没加载");
      if (tracking === false) problems.push(`感知没追踪上（假摄像头喂的是 ${input}）`);
    } catch (e) {
      problems.push((e as Error).message.split("\n")[0]);
    }

    await page.close();
    out.push({ slug, input, ok: problems.length === 0, fps, tracking, problems });
    const mark = problems.length === 0 ? "✓" : "✗";
    console.log(`${mark} ${slug.padEnd(16)} fps=${String(fps ?? "-").padStart(3)}  ${problems[0] ?? ""}`);
    for (const p of problems.slice(1)) console.log(`  ${" ".repeat(18)}${p}`);
  }

  await ctx.close();
  return out;
}

async function main() {
  const want = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const all = fs
    .readdirSync(TEMPLATES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ slug: path.basename(f, ".json"), raw: JSON.parse(fs.readFileSync(path.join(TEMPLATES, f), "utf8")) }))
    .filter((t) => want.length === 0 || want.includes(t.slug));

  if (!all.length) {
    console.error(`没有匹配的模板。可选：${fs.readdirSync(TEMPLATES).map((f) => path.basename(f, ".json")).join(" ")}`);
    process.exit(1);
  }

  // 假摄像头输入是 launch 参数，一个 browser 只能喂一种，所以按输入分组
  const groups = new Map<string, string[]>();
  for (const t of all) {
    const input = inputFor(t.raw);
    groups.set(input, [...(groups.get(input) ?? []), t.slug]);
  }

  fs.mkdirSync(OUT, { recursive: true });
  for (const input of groups.keys()) {
    const src = path.join(FIXTURES, `${input}.png`);
    const dst = path.join(OUT, `${input}.y4m`);
    /*
     * 手部输入带纵向平移，别的静止。
     *
     * 轨迹（茎）画的是「锚点走过的路」—— 静态输入下指尖永远不动，
     * 一条带都画不出来，冒烟会绿着放过一整个功能。
     * 人脸/分割那些不依赖运动，静止就够，省下一堆帧的体积。
     *
     * 幅度只取 0.22：平移是靠「越界夹到边缘行」实现的，幅度大了画面顶部会拖出
     * 明显的竖条拉丝，之后看冒烟截图时容易把那个当成效果的 bug。
     * 0.22 屏在 0.75 秒里走完，对轨迹来说已经够长。
     */
    const pan = input === "front" ? { frames: 4 } : { frames: 45, panY: 0.22 };
    const info = pngToY4m(src, dst, pan);
    console.log(
      `假摄像头 ${input}: ${info.w}x${info.h} × ${info.frames} 帧` +
        `${pan.panY ? `（纵向平移 ${pan.panY * 100}%）` : "（静止）"}, ${(info.bytes / 1024 / 1024).toFixed(1)}MB`,
    );
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`\n起 dev server（${baseUrl}）…`);
  const dev: ChildProcess = spawn("npx", ["next", "dev", "-p", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXT_DIST_DIR: ".next-smoke" },
  });
  const devLog: string[] = [];
  dev.stdout?.on("data", (d) => devLog.push(String(d)));
  dev.stderr?.on("data", (d) => devLog.push(String(d)));

  const results: Result[] = [];
  /** 手机端专项只跑一次，见下面的注释 */
  let mobileChecked = false;
  let browser: Browser | null = null;
  try {
    await waitForServer(baseUrl, 90_000);

    for (const [input, slugs] of groups) {
      browser = await chromium.launch({
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          `--use-file-for-fake-video-capture=${path.join(OUT, `${input}.y4m`)}`,
          // headless chromium 默认没有 GPU，不开这几个开关 WebGL 会拿到纯黑
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
        ],
      });
      console.log(`\n--- 输入 ${input}（${slugs.length} 个模板）---`);
      results.push(...(await runGroup(browser, baseUrl, slugs, input)));

      /*
       * 手机端专项只跑一次。它验的是**全局 UI 和摄像头约束**，
       * 不是每个模板各有一份 —— 每个模板都测一遍纯属浪费。
       */
      if (!mobileChecked) {
        mobileChecked = true;
        const mp = await checkMobile(browser, baseUrl, slugs[0]);
        const mark = mp.length === 0 ? "✓" : "✗";
        console.log(`${mark} ${"（手机端）".padEnd(14)} ${mp[0] ?? ""}`);
        for (const p of mp.slice(1)) console.log(`  ${" ".repeat(16)}${p}`);
        results.push({ slug: "mobile", input, ok: mp.length === 0, fps: null, tracking: null, problems: mp });
      }

      await browser.close();
      browser = null;
    }
  } catch (e) {
    console.error(`\n跑不起来：${(e as Error).message}`);
    console.error(devLog.slice(-12).join(""));
    process.exitCode = 1;
  } finally {
    await browser?.close();
    dev.kill("SIGTERM");
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n截图在 ${path.relative(ROOT, OUT)}/`);
  console.log(`${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log("\n失败的：");
    for (const r of bad) console.log(`  ${r.slug}: ${r.problems.join("；")}`);
    process.exitCode = 1;
  }
}

void main();
