-- 模拟盘仓位记下它是按哪一版**买入**规则开的（2026-08-13）。
--
-- 为什么现在加：2026-08-13 删掉了规则引擎的均线趋势项（实测方向是反的），删完之后
-- score 只由 RSI 单因子决定。已有的 279 笔仓位是按含趋势项的旧规则开的，之后新开的
-- 是按新规则——两批混在一张表里，将来算卖出侧胜率时**拆不开**，而卖出侧样本正是
-- 模拟盘存在的唯一理由。跟 v1/v2 卖出规则并行时分 close_reason 档位是同一个道理。
--
-- 'v1' = 含均线趋势项（2026-08-13 之前）；'v2' = RSI 单因子。
-- 已有行全部回填成 v1：它们确实是旧规则开的。
ALTER TABLE paper_trades ADD COLUMN entry_rule_version TEXT NOT NULL DEFAULT 'v1';

CREATE INDEX IF NOT EXISTS idx_paper_trades_entry_rule ON paper_trades (entry_rule_version, status);
