// 把副本里算好的 market_baseline_daily 合并回生产库。
//
// 用法（云端容器里跑）：
//   node scripts/merge-market-baseline.mjs /tmp/analysis.sqlite
//
// 这是"重活对副本跑"这条流程的最后一步（见 scripts/copy-db-for-analysis.mjs）：
// 副本上算了几十分钟的东西，合并回来只是几百行的一次短写事务，采集器最多被挡几毫秒。
import Database from "better-sqlite3";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "merge-market-baseline",
  usage: "node scripts/merge-market-baseline.mjs <副本路径>",
  positionals: [{ name: "source", label: "副本路径", default: null }],
});
const source = args.source;
if (!source) {
  console.error("用法：node scripts/merge-market-baseline.mjs <副本路径>");
  process.exit(1);
}

const db = new Database(resolveDbPath(null));
db.exec(`ATTACH DATABASE '${source.replaceAll("'", "''")}' AS src`);

const before = db.prepare("SELECT COUNT(*) c FROM market_baseline_daily").get().c;
// 口径版本随行一起搬过来，meta 底档也一并合并（迁移 024）。**不合口径就搬数字**的话，
// 生产库里会多出一批不知道是哪套口径算的行，而这张表的全部价值就在于说得清这件事。
const merge = db.transaction(() => {
  db.exec(`
    INSERT INTO market_baseline_daily
      (day, horizon_days, calc_version, median_return, sample_count, item_count, computed_at)
    SELECT day, horizon_days, calc_version, median_return, sample_count, item_count, computed_at
    FROM src.market_baseline_daily
    WHERE true
    ON CONFLICT(day, horizon_days, calc_version) DO UPDATE SET
      median_return = excluded.median_return,
      sample_count = excluded.sample_count,
      item_count = excluded.item_count,
      computed_at = excluded.computed_at
  `);
  db.exec(`
    INSERT INTO market_baseline_meta
      (calc_version, caliber_json, script_sha, git_commit, horizons, first_day, last_day, row_count, created_at, updated_at)
    SELECT calc_version, caliber_json, script_sha, git_commit, horizons, first_day, last_day, row_count, created_at, updated_at
    FROM src.market_baseline_meta
    WHERE true
    ON CONFLICT(calc_version) DO UPDATE SET
      horizons = excluded.horizons,
      first_day = excluded.first_day,
      last_day = excluded.last_day,
      row_count = excluded.row_count,
      updated_at = excluded.updated_at
  `);
});
merge();

const after = db.prepare("SELECT COUNT(*) c FROM market_baseline_daily").get().c;
db.exec("DETACH DATABASE src");

console.log(`合并完成：${before} → ${after} 行`);
for (const r of db
  .prepare(
    `SELECT calc_version v, horizon_days h, COUNT(*) c, MIN(day) a, MAX(day) b
     FROM market_baseline_daily GROUP BY v, h ORDER BY v, h`
  )
  .all()) {
  console.log(`  口径 ${r.v} / 窗口 ${String(r.h).padStart(2)} 天：${String(r.c).padStart(3)} 天（${r.a} ~ ${r.b}）`);
}
// 多于一版口径不是错，但必须看得见——评估脚本默认只读当前那一版。
const versions = db.prepare("SELECT COUNT(DISTINCT calc_version) c FROM market_baseline_daily").get().c;
if (versions > 1) {
  console.log(`⚠️ 表里现在并存 ${versions} 版口径。旧版行是历史结论的依据，别删；`);
  console.log("   读的时候用 loadBaseline(db, horizon, calcVersion) 显式指定要哪一版。");
}
