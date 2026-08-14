-- 每日采集 régime 快照（2026-08-14）。
--
-- 为什么要单独一张表：算"历史均值"当对照基数时踩的。price_snapshots 一路回溯到 2025-06，
-- 全表平均是每小时 280 行，最近 7 天的中位数是每小时 3236 行——**相差 11 倍，两个数都算对了**，
-- 错的是把 2025 年的稀疏 K 线回填跟今天 325 饰品 × 多平台当成同一个总体。
-- **基数本身是对的数，只是来自另一个世界。**
--
-- 这跟 `price_snapshots.volume` 是在售量不是成交量是同构的失效模式：那次是字段的语义跟
-- 名字对不上，这次是**同一字段的语义在时间轴上变了**。两个都不报错。
--
-- 光靠 market_baseline_daily 看不出来这件事：它只存聚合结果（中位数、样本数、饰品数），
-- **当天有几个平台参与、数据有多密，这些信息在聚合之外，用的人看不见**。
-- 所以这里每天存一行原始规模，读取方可以自己按 régime 过滤或分段。
--
-- 为什么不加到 market_baseline_daily 上：那张表的每一行属于某个 calc_version（迁移 024），
-- 而"当天有几个平台"是**数据本身的属性**，跟用哪套口径算基准无关。挂上去会让同一个事实
-- 在每个口径版本里各存一份，而且按护栏 (b) 存量行不能改写，加列只会得到一堆 NULL。
CREATE TABLE IF NOT EXISTS market_regime_daily (
  day TEXT PRIMARY KEY,             -- UTC 的 yyyy-mm-dd
  snapshot_rows INTEGER NOT NULL,   -- 当天写入的快照行数
  item_count INTEGER NOT NULL,      -- 当天有快照的不同饰品数（**注意这是代理指标**，见下）
  platform_count INTEGER NOT NULL,  -- 当天有快照的不同平台数——平台构成变了，均价和超额就跟着变
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ⚠️ `item_count` 是"当天有快照的饰品数"，**不等于"被追踪的饰品集合"**。
-- K 线回填期间它会把候选池也算进去：2026-07-17~21 是 673~746，回填一停立刻落回 325。
-- 2026-08-14 差点据此得出"7-26 没有扩容"的错误结论，而 watchlist 的一手记录是
-- 当天 41 → 282（那 241 个新增里 241 个在加入前就已经在采了，所以这一列看不出变化）。
-- 被追踪集合要查 `watchlist.created_at`，用 scripts/report-tracking-scope.mjs。
CREATE INDEX IF NOT EXISTS idx_market_regime_day ON market_regime_daily (day);
