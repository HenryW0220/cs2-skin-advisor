-- 影子卖出规则的决策记录（2026-08-03）。
--
-- 背景：现有卖出规则（lib/rules/evaluate.ts）在结构上永远触发不了——SELL 要 score ≤ -40，
-- 全库最负是 -30，能补差额的成交量项是死信号（HANDOFF 踩坑 43）。所以模拟盘 230 笔仓位
-- 一笔也平不掉，卖出侧至今零样本。
--
-- 新规则（lib/rules/sell-rule-v2.ts）的阈值全部从回测反推（scripts/build-sell-rule-baseline.mjs），
-- 但按项目所有者定的口径**不能直接替换**：要先和现有规则并行跑至少一轮，拿出触发次数和
-- 假信号率再谈。这张表就是并行期的记录——只写不读，不参与任何真实决策。
--
-- 假信号怎么判：这里只记决策当时的状态，7 天后由 scripts/report-shadow-sell-signals.mjs
-- 回头查当时那个价格之后的实际走势（卖出信号发出后价格继续涨 = 假信号）。
-- 所以 price 这一列必须存决策当时的价，不能事后重查。
CREATE TABLE IF NOT EXISTS shadow_sell_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL,        -- 对应 paper_trades.id，看得出这笔仓位当时的成本
  item_name TEXT NOT NULL,
  platform TEXT NOT NULL,           -- 决策依据的参考平台，回查走势要用同一个
  rule_version TEXT NOT NULL,       -- 'v2'，将来还有 v3 的话同一张表能并存对比
  action TEXT NOT NULL,             -- 'SELL_STRONG' | 'SELL' | 'HOLD'
  reason TEXT NOT NULL,
  price REAL NOT NULL,              -- 决策当时的价格，判假信号的基准
  return_24h REAL NOT NULL,         -- 决策当时的 24h 涨跌幅（小数），主要触发依据
  drawdown_48h REAL NOT NULL,       -- 决策当时的 48h 回撤，洗盘否决的依据
  decided_at TEXT NOT NULL,         -- 用决策依据那条快照的时间，不是写库时间
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 同一笔仓位同一时刻只记一次；模拟盘每小时跑一轮，靠这个防重复写入
  UNIQUE (trade_id, rule_version, decided_at)
);

CREATE INDEX IF NOT EXISTS idx_shadow_sell_action ON shadow_sell_signals (action, decided_at);
