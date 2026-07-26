#!/usr/bin/env node
/**
 * 把 src/content/templates/*.json 灌进 templates 表。
 *
 * 为什么必须有这一步：entitlements.template_id 和 orders.template_id 都是指向
 * templates.id 的外键。模板本身现在从仓库的 JSON 读，templates 表默认是空的，
 * 空表会让发权益的 INSERT ... SELECT 插 0 行——付了钱拿不到东西。
 *
 * 用法：DATABASE_URL=postgres://... npm run db:seed
 *
 * 幂等，可以反复跑。改了 JSON 之后重跑一次即可。
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("需要 DATABASE_URL");
  process.exit(1);
}

const DIR = path.join(process.cwd(), "src/content/templates");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error(`${DIR} 里没有模板 JSON`);
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 3 });

try {
  let n = 0;
  for (const file of files) {
    const t = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));

    // 只做最基本的检查。真正的 schema 校验在 src/lib/validate.ts，
    // 应用加载模板时会跑，`npm run build:check` 也会因此失败。
    for (const k of ["slug", "name", "category", "price_cents", "emitter", "substance", "controls"]) {
      if (t[k] === undefined) throw new Error(`${file} 缺字段 ${k}`);
    }

    await pool.query(
      `INSERT INTO templates (slug, name_json, category, price_cents, config_json,
                              preview_json, status, sort_order, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'live', $7, now())
       ON CONFLICT (slug) DO UPDATE
         SET name_json = EXCLUDED.name_json,
             category = EXCLUDED.category,
             price_cents = EXCLUDED.price_cents,
             config_json = EXCLUDED.config_json,
             preview_json = EXCLUDED.preview_json,
             sort_order = EXCLUDED.sort_order`,
      [
        t.slug,
        JSON.stringify(t.name),
        t.category,
        t.price_cents,
        JSON.stringify(t),
        JSON.stringify(t.preview ?? {}),
        t.sort_order ?? 999,
      ],
    );
    console.log(`  ✓ ${t.slug}  $${(t.price_cents / 100).toFixed(2)}`);
    n++;
  }
  console.log(`\n${n} 个模板已同步进 templates 表`);
} catch (e) {
  console.error("\n灌库失败：", e.message);
  process.exit(1);
} finally {
  await pool.end();
}
