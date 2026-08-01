/**
 * Service Worker：把模型权重和 wasm 缓存下来。
 *
 * 第二次进来就不用再下几十 MB —— 这几个文件是**内容寻址**的（URL 里带版本），
 * 所以可以放心 cache-first，不需要重新校验。
 *
 * ⚠️ 它**解决不了国内打不开的问题**。缓存只对「已经成功下过一次」的人有效，
 * 而国内的痛点是第一次就下不下来。那个只能靠自托管（见 docs/ROADMAP.md），
 * 别把这两件事混为一谈。
 *
 * 只缓存模型和 wasm，不碰页面和 API：页面缓存住了会让人看到旧版本，
 * 而这个项目还在天天改。
 */
const CACHE = "ar-models-v1";
const MODEL_HOSTS = ["storage.googleapis.com", "cdn.jsdelivr.net"];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      // 换版本时清掉旧的，不然缓存会一直涨
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("ar-models-") && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const isModel =
    MODEL_HOSTS.includes(url.hostname) &&
    /\.(task|tflite|wasm|binarypb|data|js)$/.test(url.pathname);
  const isSelfHosted = url.origin === self.location.origin && url.pathname.startsWith("/vendor/");
  if (e.request.method !== "GET" || (!isModel && !isSelfHosted)) return;

  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      // 只缓存成功的响应。把 404/超时缓存下来会让「一次失败永远失败」
      if (res.ok || res.type === "opaque") cache.put(e.request, res.clone()).catch(() => {});
      return res;
    })(),
  );
});
