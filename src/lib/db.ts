import "server-only";
import { Pool } from "pg";

/**
 * 数据访问。
 *
 * 有 DATABASE_URL 就连 Postgres，没有就退回进程内内存态——
 * 目的是 clone 下来 `npm run dev` 立刻能跑通「解锁 → 用上模板」的完整体验，
 * 不用先起数据库。
 *
 * 内存态只在 NODE_ENV !== "production" 下允许。生产环境缺 DATABASE_URL 直接抛，
 * 因为那意味着权益会随进程重启丢失，而且多实例之间不一致。
 */

const url = process.env.DATABASE_URL;
const isProd = process.env.NODE_ENV === "production";

/** 复用连接池，避免 Next 热更新时泄漏。 */
const globalForDb = globalThis as unknown as { __pool?: Pool; __mem?: MemoryStore };

/**
 * 惰性取连接池。
 *
 * 不能在模块顶层就 throw——`next build` 期间 NODE_ENV 已经是 production，
 * 收集页面数据时会加载这个模块，构建机上没有 DATABASE_URL 会直接把构建炸掉。
 * 检查必须发生在真正要读写的时候。
 */
function db(): Pool | null {
  if (!url) {
    if (isProd) {
      throw new Error(
        "DATABASE_URL is required in production: 内存态权益会随进程重启丢失，且多实例之间不一致",
      );
    }
    return null;
  }
  return (globalForDb.__pool ??= new Pool({ connectionString: url, max: 5 }));
}

/* ---------------- 内存兜底 ---------------- */

interface MemoryStore {
  entitlements: Set<string>; // `${userId}:${slug}`
  orders: Map<string, { userId: string; slug: string; status: string }>;
  events: { userId: string | null; slug: string | null; event: string; at: number }[];
}

const mem: MemoryStore =
  globalForDb.__mem ??
  (globalForDb.__mem = { entitlements: new Set(), orders: new Map(), events: [] });

export const usingMemoryStore = !url;

/* ---------------- 权益 ---------------- */

export async function grantEntitlement(userId: string, slug: string, source: string, orderId?: string) {
  const pool = db();
  if (!pool) {
    mem.entitlements.add(`${userId}:${slug}`);
    return;
  }
  const res = await pool.query(
    `INSERT INTO entitlements (user_id, template_id, source, order_id, granted_at)
     SELECT $1, t.id, $3, $4, now() FROM templates t WHERE t.slug = $2
     ON CONFLICT (user_id, template_id) DO UPDATE SET revoked_at = NULL`,
    [userId, slug, source, orderId ?? null],
  );
  // 这条 INSERT ... SELECT 在 templates 表里找不到 slug 时会插 0 行且不报错。
  // 静默通过的后果是「用户付了钱、webhook 返回 200、权益没发」，必须炸。
  if (!res.rowCount) {
    throw new Error(
      `发放权益失败：templates 表里没有 slug="${slug}"。跑一次 npm run db:seed 把模板灌进去`,
    );
  }
}

export async function revokeEntitlement(userId: string, slug: string) {
  const pool = db();
  if (!pool) {
    mem.entitlements.delete(`${userId}:${slug}`);
    return;
  }
  await pool.query(
    `UPDATE entitlements e SET revoked_at = now()
     FROM templates t WHERE t.id = e.template_id AND e.user_id = $1 AND t.slug = $2`,
    [userId, slug],
  );
}

export async function unlockedSlugs(userId: string): Promise<string[]> {
  const pool = db();
  if (!pool) {
    return [...mem.entitlements]
      .filter((k) => k.startsWith(`${userId}:`))
      .map((k) => k.slice(userId.length + 1));
  }
  const { rows } = await pool.query<{ slug: string }>(
    `SELECT t.slug FROM entitlements e JOIN templates t ON t.id = e.template_id
     WHERE e.user_id = $1 AND e.revoked_at IS NULL`,
    [userId],
  );
  return rows.map((r) => r.slug);
}

/* ---------------- 用户 ---------------- */

/**
 * 登录时把用户落库。
 *
 * session 走 JWT，本来不需要 users 表，但 orders.user_id 有指向 users(id) 的外键，
 * 不落用户的话第一笔订单就会因为外键失败。
 *
 * 没有数据库时静默跳过而不是抛：登录不该硬失败。真正需要严格的是权益和订单，
 * 那两条路上没有用户记录会自己炸出来。
 */
export async function upsertUser(u: {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}) {
  if (!url) {
    if (isProd) console.warn("[users] skipped: DATABASE_URL not set");
    return;
  }
  const pool = db()!;
  await pool.query(
    `INSERT INTO users (id, email, name, avatar_url, google_sub, created_at)
     VALUES ($1, $2, $3, $4, $1, now())
     ON CONFLICT (id) DO UPDATE
       SET email = COALESCE(EXCLUDED.email, users.email),
           name = COALESCE(EXCLUDED.name, users.name),
           avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
           deleted_at = NULL`,
    [u.id, u.email ?? null, u.name ?? null, u.image ?? null],
  );
}

/* ---------------- 订单 ---------------- */

/** 落一笔已付款的订单。幂等靠 stripe_session_id 的唯一约束。 */
export async function recordOrder(o: {
  userId: string;
  slug: string;
  sessionId: string;
  paymentIntent: string | null;
  amountCents: number;
  currency: string;
}) {
  const pool = db();
  if (!pool) return;
  await pool.query(
    `INSERT INTO orders (user_id, template_id, stripe_session_id, stripe_payment_intent,
                         amount_cents, currency, status, created_at)
     SELECT $1, t.id, $3, $4, $5, $6, 'paid', now() FROM templates t WHERE t.slug = $2
     ON CONFLICT (stripe_session_id) DO NOTHING`,
    [o.userId, o.slug, o.sessionId, o.paymentIntent, o.amountCents, o.currency],
  );
}

/**
 * 退款 / 争议时按 payment_intent 反查是谁买了哪个模板。
 *
 * 不能指望 Stripe 把 Checkout Session 的 metadata 传到 charge 上——那不保证。
 * 自己的 orders 表才是可靠的来源。
 */
export async function findOrderByPaymentIntent(
  pi: string,
): Promise<{ userId: string; slug: string } | null> {
  const pool = db();
  if (!pool) return null;
  const { rows } = await pool.query<{ user_id: string; slug: string }>(
    `SELECT o.user_id, t.slug FROM orders o JOIN templates t ON t.id = o.template_id
     WHERE o.stripe_payment_intent = $1 LIMIT 1`,
    [pi],
  );
  const r = rows[0];
  return r ? { userId: r.user_id, slug: r.slug } : null;
}

export async function markOrderStatus(pi: string, status: string) {
  const pool = db();
  if (!pool) return;
  await pool.query(`UPDATE orders SET status = $2 WHERE stripe_payment_intent = $1`, [pi, status]);
}

/* ---------------- 订单幂等 ---------------- */

/** 返回 true 表示这个事件是第一次见到，应当处理。Stripe 会重发，必须幂等（PRD 8）。 */
export async function claimStripeEvent(eventId: string): Promise<boolean> {
  const pool = db();
  if (!pool) {
    if (mem.orders.has(eventId)) return false;
    mem.orders.set(eventId, { userId: "", slug: "", status: "seen" });
    return true;
  }
  const { rowCount } = await pool.query(
    `INSERT INTO stripe_events (id, received_at) VALUES ($1, now()) ON CONFLICT (id) DO NOTHING`,
    [eventId],
  );
  return rowCount === 1;
}

/* ---------------- 埋点 ---------------- */

export async function recordEvents(
  rows: { userId: string | null; slug: string | null; event: string; meta?: unknown }[],
) {
  // 这里故意不走 db()：埋点丢了不影响正确性，不值得为它在生产环境抛 500。
  // 权益那边照旧严格——少一条漏斗数据和放错一个付费模板不是一个量级的事。
  if (!url) {
    for (const r of rows) mem.events.push({ ...r, at: Date.now() });
    if (isProd) console.warn("[events] dropped: DATABASE_URL not set");
    return;
  }
  const pool = db()!;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO usage_events (user_id, template_id, event, meta_json, created_at)
       SELECT $1, t.id, $3, $4, now() FROM templates t WHERE t.slug = $2`,
      [r.userId, r.slug, r.event, JSON.stringify(r.meta ?? {})],
    );
  }
}
