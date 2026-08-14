-- 大盘基准的口径版本化（2026-08-14）。
--
-- market_baseline_daily 跟这个库里别的表不一样：它不是观测到的事实，是**用当天的数据
-- 算出来、被三个评估脚本长期复用的中间产物**。所有引用它的结论（v2 的阈值、影子成绩单、
-- 模拟盘超额）都隐含"基准是那套口径算的"这个前提，而这个前提原来没有任何地方记着。
--
-- 迁移 023 的表在两件事上会静默失配：
--   ① 口径（参考平台优先级、历史长度门槛、样本下限、中位数取法）只活在
--      scripts/market-baseline-store.mjs 的常量里，改了以后表里的行不会自己变、也看不出
--      是哪一套算的。将来结论对不上时，第一件要查的就是"基准变过没有"，而查不了。
--   ② 原来的 PRIMARY KEY (day, horizon_days) 决定了改口径只能就地覆盖（那个模块的注释
--      当时写的就是"先 DELETE 再重跑"）。一覆盖，8-13 之前所有引用这张表的结论就都失去
--      可复现性——那正是这个项目一直在防的"同一份数据被反复检视"的另一种形式。
--
-- 所以：主键加进 calc_version，**同一 (天, 窗口) 的不同口径并存**，改口径只能新写一版；
-- 每一版的口径本身连同生成它的脚本指纹/commit/回填区间，记在 market_baseline_meta 里。
--
-- calc_version 不是手写的版本号，是 scripts/market-baseline-store.mjs 按那几个常量算出来的
-- 指纹（BASELINE_CALC_VERSION）。手写版本号迟早会有人忘了改，指纹改了口径就自动变成新版，
-- 想覆盖也覆盖不了。下面这个字面量就是 2026-08-13 首次回填时那套口径的指纹——
-- 存量 111 行是它算出来的，所以直接打上这个值。**不要手改这个字符串**：它对不上的话
-- 读取端会明确报错（assertBaselineTable），而不是悄悄返回空基准。
CREATE TABLE IF NOT EXISTS market_baseline_meta (
  calc_version TEXT PRIMARY KEY,
  caliber_json TEXT NOT NULL,       -- 口径本身（平台优先级/历史长度门槛/样本下限/中位数取法…）
  script_sha TEXT NOT NULL,         -- 生成这批行的脚本内容指纹，比 commit 更准（手工拷进容器的版本也认得出）
  git_commit TEXT NOT NULL,         -- 生成时的镜像 commit，没有就是 'unknown'（Dockerfile 的 GIT_COMMIT）
  horizons TEXT NOT NULL,           -- 这一版算过哪些窗口天数，逗号分隔
  first_day TEXT,                   -- 回填覆盖的日期区间
  last_day TEXT,
  row_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- SQLite 不能给已有表的主键加列，只能重建。
CREATE TABLE IF NOT EXISTS market_baseline_daily_v2 (
  day TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  calc_version TEXT NOT NULL,
  median_return REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, horizon_days, calc_version)
);

INSERT OR IGNORE INTO market_baseline_daily_v2
  (day, horizon_days, calc_version, median_return, sample_count, item_count, computed_at)
SELECT day, horizon_days, 'b9645fa10', median_return, sample_count, item_count, computed_at
FROM market_baseline_daily;

DROP TABLE market_baseline_daily;
ALTER TABLE market_baseline_daily_v2 RENAME TO market_baseline_daily;

INSERT OR IGNORE INTO market_baseline_meta
  (calc_version, caliber_json, script_sha, git_commit, horizons, first_day, last_day, row_count, created_at)
SELECT 'b9645fa10',
       '{"historyGateHours":"24*(horizon+14)","itemUniverse":"DISTINCT item_name FROM price_snapshots","medianRule":"even-count=mean-of-two-middles","minSamplesPerDay":20,"minSnapshotsPerItem":200,"platformPriority":"C5,BUFF,YOUPIN","resample":"hourly-last","settleHours":6}',
       'backfilled',
       'unknown',
       (SELECT GROUP_CONCAT(DISTINCT horizon_days) FROM market_baseline_daily),
       (SELECT MIN(day) FROM market_baseline_daily),
       (SELECT MAX(day) FROM market_baseline_daily),
       (SELECT COUNT(*) FROM market_baseline_daily),
       '2026-08-13T19:25:00Z'
WHERE EXISTS (SELECT 1 FROM market_baseline_daily);
