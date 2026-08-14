// 把副本里算好的 market_baseline_daily 合并回生产库。
//
// 用法（云端容器里跑）：
//   node scripts/merge-market-baseline.mjs /tmp/analysis.sqlite
//
// 这是"重活对副本跑"这条流程的最后一步（见 scripts/copy-db-for-analysis.mjs）：
// 副本上算了几十分钟的东西，合并回来只是几百行的一次短写事务，采集器最多被挡几毫秒。
import Database from "better-sqlite3";

const source = process.argv[2];
if (!source) {
  console.error("用法：node scripts/merge-market-baseline.mjs <副本路径>");
  process.exit(1);
}

const db = new Database(process.env.CS2_DB_PATH ?? "data/db.sqlite");
db.exec(`ATTACH DATABASE '${source.replaceAll("'", "''")}' AS src`);

const before = db.prepare("SELECT COUNT(*) c FROM market_baseline_daily").get().c;
const merge = db.transaction(() => {
  db.exec(`
    INSERT INTO market_baseline_daily (day, horizon_days, median_return, sample_count, item_count, computed_at)
    SELECT day, horizon_days, median_return, sample_count, item_count, computed_at
    FROM src.market_baseline_daily
    WHERE true
    ON CONFLICT(day, horizon_days) DO UPDATE SET
      median_return = excluded.median_return,
      sample_count = excluded.sample_count,
      item_count = excluded.item_count,
      computed_at = excluded.computed_at
  `);
});
merge();

const after = db.prepare("SELECT COUNT(*) c FROM market_baseline_daily").get().c;
db.exec("DETACH DATABASE src");

console.log(`合并完成：${before} → ${after} 行`);
for (const r of db
  .prepare("SELECT horizon_days h, COUNT(*) c, MIN(day) a, MAX(day) b FROM market_baseline_daily GROUP BY h ORDER BY h")
  .all()) {
  console.log(`  窗口 ${String(r.h).padStart(2)} 天：${String(r.c).padStart(3)} 天（${r.a} ~ ${r.b}）`);
}
