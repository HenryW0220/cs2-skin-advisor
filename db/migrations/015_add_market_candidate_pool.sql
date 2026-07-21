-- C1/C2 全市场随机候选池（REPORT-C1-C2.md 指出候选池不是全市场随机样本，这里补上）。
-- 只存抽样名单本身，保证跨报告版本口径一致（不是每次重跑分析脚本都重新随机抽一遍）；
-- 价格历史跟真实跟踪饰品一样落 price_snapshots，不需要单独的价格表。
CREATE TABLE IF NOT EXISTS market_candidate_pool (
  item_name TEXT PRIMARY KEY,
  rarity TEXT,
  sampled_at TEXT NOT NULL DEFAULT (datetime('now'))
);
