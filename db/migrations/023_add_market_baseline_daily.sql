-- 大盘基准物化表（2026-08-13）。
--
-- 为什么要物化：三个评估脚本（build-sell-rule-baseline / report-shadow-sell-signals /
-- report-paper-trades）都要"当天全市场未来 N 天收益的中位数"这个基准，各自算各自的，
-- 而这一段是它们唯一的重活——report-paper-trades 在生产库上跑 22 分钟，绝大部分时间
-- 花在这里，report-shadow-sell-signals 干脆跑不完。基准只跟(日期, 窗口)有关、跟哪个
-- 脚本无关，所以算一次存起来，三个脚本共用。
--
-- **口径统一到 build-sell-rule-baseline.mjs 那一套**（v2 的全部阈值就是从它反推的）：
-- 按饰品取参考平台、按小时重采样，每个小时样本算"未来 horizon_days 天的收益"，
-- 当天所有饰品所有小时样本的中位数就是这一天的基准。此前 report-shadow-sell-signals
-- 用的是"每个饰品每天取一条"的近似口径，数字会有小幅差异——统一之后以这张表为准。
--
-- 增量更新：价格是只追加的，所以一天的基准在 day + horizon + 6 小时之后就不会再变，
-- 已经写进来的行不重算（scripts/build-market-baseline.mjs）。
CREATE TABLE IF NOT EXISTS market_baseline_daily (
  day TEXT NOT NULL,                -- 基准日，UTC 的 yyyy-mm-dd
  horizon_days INTEGER NOT NULL,    -- 前瞻窗口天数。7 是主口径；模拟盘按持有天数算，会有别的值
  median_return REAL NOT NULL,      -- 当天全市场未来 horizon_days 天收益的中位数（小数）
  sample_count INTEGER NOT NULL,    -- 参与中位数的(饰品,小时)样本数
  item_count INTEGER NOT NULL,      -- 参与的不同饰品数——真正的独立样本量看这个，不是上面那个
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, horizon_days)
);
