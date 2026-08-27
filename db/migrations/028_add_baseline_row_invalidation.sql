-- 行级作废标记（2026-08-23）。
--
-- 迁移 026 给 market_baseline_meta 加了 deprecated_reason，那是**版本级**的：整整一版口径
-- 作废了、错在哪。但 2026-08-23 查出的缺陷不是这个形状——
-- **b03672dc0 这一版整体是好的，只有九行是坏的**（九个窗口各一天，只用了 3 小时样本，
-- 完整应为 24 小时 × 325 饰品）。
--
-- 把整版标 deprecated 会误伤其余 966 行（它们跟继任版本 b75ea4af5 逐行相同，是好数据）；
-- 只在代码注释里写一句"那九行是坏的"又**查不出来**——而这张表的读取方是脚本不是人。
-- 所以作废必须落到行上，且必须是**可查询**的。
--
-- 三列的分工：
--   · invalid_reason  —— 为什么坏。**同时是"这一行是否有效"的判据**：非 NULL 即无效。
--   · invalidated_at  —— 什么时候判定的（留痕，便于跟当时的结论对时间）。
--   · superseded_by   —— 哪一版取代了它。**没有这一列的话，读到坏行的人不知道该去读谁。**
--
-- ⚠️ **护栏 (b) 仍然成立**：这三列只是**标注**，不改 median_return / sample_count /
-- item_count 任何一个数。8-16 那批引用 b03672dc0 的结论仍然逐字可复现——
-- 想复现的人显式传 includeInvalid 就能读到原值。
-- **作废不等于删除，也不等于改写。**
ALTER TABLE market_baseline_daily ADD COLUMN invalid_reason TEXT;
ALTER TABLE market_baseline_daily ADD COLUMN invalidated_at TEXT;
ALTER TABLE market_baseline_daily ADD COLUMN superseded_by TEXT;

-- ⚠️ **这九行是逐条列出来的，不是用"小时数 < 某个界"筛出来的。写这条迁移时先试了后者，
-- 结果多标了 13 行。** 那 13 行是 2026-04-18 ~ 04-23，即**采集刚开始那几天**，
-- 只有 3.4 ~ 10.8 小时——那是**当时就只有那么多数据**，所有拿得到的小时都用上了，
-- 是完整的、稀疏的、正确的行。把它们标成作废会有两个后果，都很糟：
--   ① loadBaseline 会把它们跳掉，凭空少掉基准最早那几天；
--   ② 它们会被贴上一段**事实错误**的原因（说是 08-15 备份截断，而它们跟那件事毫无关系）。
-- **"样本小时数少"有两个成因——采集稀疏 和 定型截断——用一个阈值分不开它们**，
-- 而这正是 market-baseline-store.mjs 顶上那句"别混"反复警告的同一件事。
--
-- 这九行的身份是**反推 + 实测对上**的（HANDOFF ㉜）：从每行的小时数反推当时那份库的
-- 数据末端，八个窗口独立收敛到 [2026-08-15T02:00Z, 03:00Z)，正是 cloud-db-2026-08-15
-- 的实际末端 02:59:56Z；窗口 20 指向 08-16 那份（02:51:17Z），跟"窗口 20 是隔天单独补的"对上。
--
-- **只标 b03672dc0**：b9645fa10 已经整版 deprecated（迁移 026），再标行是重复。
UPDATE market_baseline_daily
SET invalid_reason =
      '边界日截断：定型判据比的是 Date.now() 而不是数据末端，而全量回填跑在备份副本上'
      || '（窗口 7~16 用的是 cloud-db-2026-08-15，数据末端 02:59:56Z；'
      || '窗口 20 用的是 08-16 那份，末端 02:51:17Z），'
      || '于是这一天只有开头约 3 个小时取得到 T+N 的对手价，其余小时被静默丢弃。'
      || '样本小时数 ' || ROUND(CAST(sample_count AS REAL) / item_count, 2) || '（完整应为 24）。'
      || '叠加第二个原因：dayCompleteness=whole-day-only 当时只实现在 --daily 分支里，'
      || '全量模式没有执行它，所以这一天没有被跳过而是被写成了半份。'
      || '继任版本 b75ea4af5 两处都已修正。',
    invalidated_at = datetime('now'),
    superseded_by = 'b75ea4af5'
WHERE calc_version = 'b03672dc0'
  AND (horizon_days, day) IN (
    VALUES (7, '2026-08-08'), (8, '2026-08-07'), (9, '2026-08-06'), (10, '2026-08-05'),
           (11, '2026-08-04'), (12, '2026-08-03'), (13, '2026-08-02'), (16, '2026-07-30'),
           (20, '2026-07-27')
  );

-- 标了几行必须当场核对。**这条迁移只跑一次、跑完就不可逆**（护栏 (b) 不许重算），
-- 多标或少标都要在这里炸掉而不是留到以后被发现。
-- CHECK 约束失败会让整个迁移事务回滚——这是 SQLite 里能拿到的最简单的"迁移内断言"。
--
-- ⚠️ **判据是"该标的都标上了"，不是"标了 9 行"。第一版写死 9 就炸了 78 个测试。**
-- 原因：`lib/db/testing.ts` 给单测建的是**空的内存库**，跑同一套迁移，那里
-- b03672dc0 一行都没有 ⇒ 标出来是 0 ≠ 9 ⇒ CHECK 失败 ⇒ 迁移抛错 ⇒ 所有 db 测试全红。
-- **一个数据相关的断言写成绝对值，就把"这份库里恰好有这些行"当成了 schema 的前提**，
-- 而全新安装、测试库、任何没经历过那次坏回填的库都不满足它。
-- 正确的不变式是**两个计数相等**：空库 0=0 通过，生产 9=9 通过，
-- 而"UPDATE 漏了几行"这种真故障仍然会被抓住。
CREATE TEMP TABLE _migration_028_check (ok INTEGER CHECK (ok = 1));
INSERT INTO _migration_028_check
SELECT CASE
  WHEN (SELECT COUNT(*) FROM market_baseline_daily
        WHERE calc_version = 'b03672dc0' AND invalid_reason IS NOT NULL)
     = (SELECT COUNT(*) FROM market_baseline_daily
        WHERE calc_version = 'b03672dc0'
          AND (horizon_days, day) IN (
            VALUES (7, '2026-08-08'), (8, '2026-08-07'), (9, '2026-08-06'), (10, '2026-08-05'),
                   (11, '2026-08-04'), (12, '2026-08-03'), (13, '2026-08-02'), (16, '2026-07-30'),
                   (20, '2026-07-27')
          ))
  THEN 1 ELSE 0 END;
DROP TABLE _migration_028_check;

-- 查得出来才算数：按 (版本, 窗口) 找作废行是最常见的查法。
CREATE INDEX IF NOT EXISTS idx_baseline_invalid
  ON market_baseline_daily (calc_version, horizon_days)
  WHERE invalid_reason IS NOT NULL;
