#!/usr/bin/env node
/**
 * 数据库链路的端到端验证。
 *
 * 本机没有 Postgres 也没有 Docker，所以这些 SQL 到现在为止是「写完但没跑过」。
 * 这个脚本把它们真跑一遍：建表 → 灌模板 → 落用户 → 落订单 → 发权益 → 查权益
 * → 按 payment_intent 反查 → 退款回收 → 幂等。用完清干净自己造的测试数据。
 *
 * 用法：DATABASE_URL=postgres://... npm run db:check
 *
 * 拿到连接串之后跑这一条就知道支付链路的数据层到底成不成立。
 */
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("需要 DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 3 });
const TEST_USER = "check_user_delete_me";
const TEST_PI = "pi_check_delete_me";
const TEST_SESSION = "cs_check_delete_me";
const TEST_EVENT = "evt_check_delete_me";

let pass = 0;
let fail = 0;

function ok(label, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}${detail ? "  ← " + detail : ""}`);
    fail++;
  }
}

async function cleanup() {
  await pool.query(`DELETE FROM usage_events WHERE user_id = $1`, [TEST_USER]);
  await pool.query(`DELETE FROM entitlements WHERE user_id = $1`, [TEST_USER]);
  await pool.query(`DELETE FROM orders WHERE user_id = $1`, [TEST_USER]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [TEST_USER]);
  await pool.query(`DELETE FROM stripe_events WHERE id = $1`, [TEST_EVENT]);
}

try {
  console.log("\n1. 表结构");
  for (const t of ["users", "templates", "orders", "entitlements", "usage_events", "stripe_events"]) {
    const { rows } = await pool.query(`SELECT to_regclass($1) AS r`, [t]);
    ok(`表 ${t} 存在`, rows[0].r !== null, "先跑 psql -f db/schema.sql");
  }
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'orders' AND column_name = 'template_id'`,
  );
  ok("orders.template_id 存在", cols.length === 1, "退款回收要靠它反查模板");

  console.log("\n2. 模板已灌库");
  const { rows: tpl } = await pool.query(`SELECT slug, price_cents FROM templates ORDER BY sort_order`);
  ok(`templates 表里有模板（${tpl.length} 个）`, tpl.length > 0, "先跑 npm run db:seed");
  const paid = tpl.find((t) => t.price_cents > 0);
  ok("至少有一个付费模板", Boolean(paid));
  if (!paid) throw new Error("没有付费模板可测，先跑 npm run db:seed");
  const slug = paid.slug;

  await cleanup();

  console.log("\n3. 用户 upsert");
  await pool.query(
    `INSERT INTO users (id, email, name, google_sub, created_at)
     VALUES ($1, 'check@example.com', 'Check', $1, now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, deleted_at = NULL`,
    [TEST_USER],
  );
  await pool.query(
    `INSERT INTO users (id, email, name, google_sub, created_at)
     VALUES ($1, 'check@example.com', 'Check2', $1, now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, deleted_at = NULL`,
    [TEST_USER],
  );
  const { rows: u } = await pool.query(`SELECT name FROM users WHERE id = $1`, [TEST_USER]);
  ok("重复 upsert 不报错且覆盖字段", u.length === 1 && u[0].name === "Check2");

  console.log("\n4. 订单落库");
  const ins = await pool.query(
    `INSERT INTO orders (user_id, template_id, stripe_session_id, stripe_payment_intent,
                         amount_cents, currency, status, created_at)
     SELECT $1, t.id, $3, $4, 99, 'usd', 'paid', now() FROM templates t WHERE t.slug = $2
     ON CONFLICT (stripe_session_id) DO NOTHING`,
    [TEST_USER, slug, TEST_SESSION, TEST_PI],
  );
  ok("订单插入影响 1 行", ins.rowCount === 1, `实际 ${ins.rowCount}`);
  const again = await pool.query(
    `INSERT INTO orders (user_id, template_id, stripe_session_id, stripe_payment_intent,
                         amount_cents, currency, status, created_at)
     SELECT $1, t.id, $3, $4, 99, 'usd', 'paid', now() FROM templates t WHERE t.slug = $2
     ON CONFLICT (stripe_session_id) DO NOTHING`,
    [TEST_USER, slug, TEST_SESSION, TEST_PI],
  );
  ok("同一个 session 再插一次是 0 行（幂等）", again.rowCount === 0);

  console.log("\n5. 发权益");
  const g = await pool.query(
    `INSERT INTO entitlements (user_id, template_id, source, order_id, granted_at)
     SELECT $1, t.id, 'stripe', $3, now() FROM templates t WHERE t.slug = $2
     ON CONFLICT (user_id, template_id) DO UPDATE SET revoked_at = NULL`,
    [TEST_USER, slug, TEST_SESSION],
  );
  ok("发权益影响 1 行", g.rowCount === 1, `实际 ${g.rowCount}`);

  const bogus = await pool.query(
    `INSERT INTO entitlements (user_id, template_id, source, order_id, granted_at)
     SELECT $1, t.id, 'stripe', NULL, now() FROM templates t WHERE t.slug = $2
     ON CONFLICT (user_id, template_id) DO UPDATE SET revoked_at = NULL`,
    [TEST_USER, "slug-that-does-not-exist"],
  );
  ok(
    "不存在的 slug 会影响 0 行（代码里必须据此抛错）",
    bogus.rowCount === 0,
    "如果这里不是 0，grantEntitlement 的判断就白写了",
  );

  console.log("\n6. 查权益");
  const { rows: unlocked } = await pool.query(
    `SELECT t.slug FROM entitlements e JOIN templates t ON t.id = e.template_id
     WHERE e.user_id = $1 AND e.revoked_at IS NULL`,
    [TEST_USER],
  );
  ok("查得到刚发的权益", unlocked.some((r) => r.slug === slug));

  console.log("\n7. 退款：按 payment_intent 反查再回收");
  const { rows: found } = await pool.query(
    `SELECT o.user_id, t.slug FROM orders o JOIN templates t ON t.id = o.template_id
     WHERE o.stripe_payment_intent = $1 LIMIT 1`,
    [TEST_PI],
  );
  ok("按 payment_intent 查到订单和模板", found.length === 1 && found[0].slug === slug);

  await pool.query(
    `UPDATE entitlements e SET revoked_at = now()
     FROM templates t WHERE t.id = e.template_id AND e.user_id = $1 AND t.slug = $2`,
    [TEST_USER, slug],
  );
  const { rows: after } = await pool.query(
    `SELECT t.slug FROM entitlements e JOIN templates t ON t.id = e.template_id
     WHERE e.user_id = $1 AND e.revoked_at IS NULL`,
    [TEST_USER],
  );
  ok("回收后查不到权益了", !after.some((r) => r.slug === slug));

  await pool.query(`UPDATE orders SET status = 'refunded' WHERE stripe_payment_intent = $1`, [TEST_PI]);
  const { rows: st } = await pool.query(
    `SELECT status FROM orders WHERE stripe_payment_intent = $1`,
    [TEST_PI],
  );
  ok("订单状态改成 refunded", st[0]?.status === "refunded");

  console.log("\n8. Stripe 事件幂等");
  const e1 = await pool.query(
    `INSERT INTO stripe_events (id, received_at) VALUES ($1, now()) ON CONFLICT (id) DO NOTHING`,
    [TEST_EVENT],
  );
  const e2 = await pool.query(
    `INSERT INTO stripe_events (id, received_at) VALUES ($1, now()) ON CONFLICT (id) DO NOTHING`,
    [TEST_EVENT],
  );
  ok("同一个 event.id 第一次 1 行、第二次 0 行", e1.rowCount === 1 && e2.rowCount === 0);

  console.log("\n9. 埋点");
  const ev = await pool.query(
    `INSERT INTO usage_events (user_id, template_id, event, meta_json, created_at)
     SELECT $1, t.id, 'record_start', '{}', now() FROM templates t WHERE t.slug = $2`,
    [TEST_USER, slug],
  );
  ok("埋点写得进去", ev.rowCount === 1);

  await cleanup();
  console.log("\n测试数据已清理");
} catch (e) {
  console.error("\n跑挂了：", e.message);
  fail++;
  try {
    await cleanup();
  } catch {
    console.error("清理也失败了，可能有 check_user_delete_me 的残留数据");
  }
} finally {
  await pool.end();
}

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail === 0 ? 0 : 1);
