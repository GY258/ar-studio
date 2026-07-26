/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // dev 和 build 共用 .next 会互相覆盖：在 next dev 跑着的时候执行 next build，
  // 生产产物会盖掉 dev 的 chunk，dev server 当场 MODULE_NOT_FOUND。
  // 所以校验用的构建走 `npm run build:check`，写到另一个目录去。
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // 模板是运行时用 fs 读的，webpack 追踪不到，不显式声明的话
  // 部署产物里不会有 src/content/templates，线上就是零个模板。
  outputFileTracingIncludes: {
    "/**": ["./src/content/templates/**"],
  },
  headers: async () => [
    {
      // 自托管的模型和 wasm：内容哈希文件名 + 一年缓存（PRD 5.6）
      source: "/vendor/:path*",
      headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
    },
  ],
};

export default nextConfig;
