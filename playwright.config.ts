import { defineConfig } from "@playwright/test";

/**
 * L2 渲染回归。
 *
 * harness 自己起 chromium 和静态服务（scripts/harness-driver.ts），
 * 所以这里不配 projects / webServer —— 测试文件里不用 page fixture。
 * 一个 worker：多个 worker 各开一个 chromium 会把机器跑满，收益却是零，
 * 模板数量在几十个的量级，串行几秒就跑完。
 */
export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
});
