-- ============================================================
-- 运营查询：复制粘贴到 Neon SQL Editor 里跑
-- ============================================================

-- 1. 总览：各事件计数
SELECT event, count(*) AS total
FROM usage_events
GROUP BY event
ORDER BY total DESC;

-- 2. 按模板看漏斗：访问 → 开摄像头 → 开始录 → 下载
SELECT t.slug,
  count(*) FILTER (WHERE e.event = 'view')            AS views,
  count(*) FILTER (WHERE e.event = 'camera_grant')    AS cameras,
  count(*) FILTER (WHERE e.event = 'record_start')    AS records,
  count(*) FILTER (WHERE e.event = 'record_download') AS downloads,
  count(*) FILTER (WHERE e.event = 'unlock_click')    AS unlock_clicks
FROM usage_events e
LEFT JOIN templates t ON t.id = e.template_id
GROUP BY t.slug
ORDER BY views DESC;

-- 3. 每日活跃（DAU 近似：按天去重 user_id，匿名用户算一个）
SELECT date_trunc('day', created_at)::date AS day,
  count(DISTINCT COALESCE(user_id, 'anon')) AS users,
  count(*) AS events
FROM usage_events
GROUP BY day
ORDER BY day DESC
LIMIT 30;

-- 4. 每小时事件量（看高峰时段）
SELECT extract(hour FROM created_at) AS hour,
  count(*) AS events
FROM usage_events
GROUP BY hour
ORDER BY hour;

-- 5. 注册用户列表
SELECT id, email, name, created_at
FROM users
ORDER BY created_at DESC;

-- 6. 反馈列表
SELECT category, email, message, links, created_at
FROM feedback
ORDER BY created_at DESC;

-- 7. 付费意向：谁点了解锁
SELECT t.slug, count(*) AS clicks
FROM usage_events e
JOIN templates t ON t.id = e.template_id
WHERE e.event = 'unlock_click'
GROUP BY t.slug
ORDER BY clicks DESC;
