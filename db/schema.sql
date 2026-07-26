-- AR Studio · 数据模型（PRD 5.4）
-- 权益查询要强一致，所以放在关系库里，不放 KV。

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,              -- google sub
  email       TEXT UNIQUE,
  name        TEXT,
  avatar_url  TEXT,
  google_sub  TEXT UNIQUE,
  locale      TEXT DEFAULT 'zh',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS templates (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  name_json    JSONB NOT NULL,
  category     TEXT NOT NULL,
  price_cents  INTEGER NOT NULL DEFAULT 0,
  config_json  JSONB NOT NULL,               -- 完整模板配置，新增模板不发版就靠它
  preview_json JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | live | archived
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id                     BIGSERIAL PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id),
  -- 退款回收权益要靠它反查买的是哪个模板。
  -- 不能指望 Stripe 把 session 的 metadata 传到 charge 上，那不保证。
  template_id            BIGINT REFERENCES templates(id),
  stripe_session_id      TEXT UNIQUE,
  stripe_payment_intent  TEXT,
  amount_cents           INTEGER NOT NULL,
  currency               TEXT NOT NULL DEFAULT 'usd',
  status                 TEXT NOT NULL,       -- pending | paid | refunded | disputed
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entitlements (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  template_id BIGINT NOT NULL REFERENCES templates(id),
  source      TEXT NOT NULL,                  -- stripe | promo | dev | grant
  order_id    TEXT,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  UNIQUE (user_id, template_id)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT,
  template_id BIGINT REFERENCES templates(id),
  event       TEXT NOT NULL,                  -- view | camera_grant | record_start | record_download | unlock_click
  meta_json   JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stripe webhook 幂等：同一个 event.id 只处理一次
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_pi ON orders (stripe_payment_intent);
CREATE INDEX IF NOT EXISTS idx_events_created ON usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_funnel ON usage_events (event, created_at DESC);
