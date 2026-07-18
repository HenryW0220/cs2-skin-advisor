-- 自动异常检测产生的候选事件：每小时同步后台跑统计异常检测（价格 z-score、成交量倍数），
-- 命中阈值就落一条 pending 记录，用户去 /anomalies 页面确认或忽略。
-- 这张表同时服务两个目的：(1) 不需要标签就能主动提醒"这里动静不对"；
-- (2) 用户确认/忽略的结果本身就是训练用的正/负样本——忽略掉的候选正是之前
-- 手动标记缺的"负样本"，不用额外造数据。
CREATE TABLE IF NOT EXISTS anomaly_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  metric TEXT NOT NULL,             -- 'price_zscore' | 'volume_ratio'
  detected_at TEXT NOT NULL,        -- 对应触发异常的那条 price_snapshots.captured_at
  value REAL NOT NULL,              -- z-score 或成交量倍数的具体数值
  price REAL NOT NULL,              -- 触发时的价格，回看用
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'confirmed' | 'dismissed'
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_name, platform, metric, detected_at)
);

CREATE INDEX IF NOT EXISTS idx_anomaly_events_status ON anomaly_events (status);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_item_name ON anomaly_events (item_name);
