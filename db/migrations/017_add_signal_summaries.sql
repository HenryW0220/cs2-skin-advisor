-- 持仓/观察池页面用的信号预计算结果。价格数据只在每小时同步时变化，页面每次渲染
-- 都对每个饰品现场重算 MA/RSI/嫌疑分是页面慢的主因——改成同步收尾时算一遍存这里，
-- 页面直接读表。score 与 holding 无关（action 才区分持仓/观察池），只存一份够用，
-- 见 lib/signal-precompute.ts。
CREATE TABLE IF NOT EXISTS item_signal_summaries (
  item_name TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  market_price REAL NOT NULL,
  action TEXT NOT NULL,
  score REAL NOT NULL,
  change_today_percent REAL,
  recent_prices TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
