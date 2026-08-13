// 把"当天全市场未来 N 天收益的中位数"算好存进 market_baseline_daily（迁移 023）。
//
// 用法（云端容器里跑）：
//   node scripts/build-market-baseline.mjs            # 主口径 7 天
//   node scripts/build-market-baseline.mjs 7 12 14    # 指定多个窗口（模拟盘按持有天数算）
//
// **这是三个评估脚本里唯一会写库的一个**，报告脚本一律只读——报告顺手写库的话，
// 同一份报告在不同时间跑会读到不同的缓存内容，出了问题分不清是数据变了还是缓存脏了。
// 增量：已经存过的 (天, 窗口) 不重算，价格只追加、定型之后不会变。
import Database from "better-sqlite3";
import { assertBaselineTable, ensureBaselines } from "./market-baseline-store.mjs";

const args = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const horizons = args.length ? args : [7];

const db = new Database(process.env.CS2_DB_PATH ?? "data/db.sqlite");
assertBaselineTable(db);

const startedAt = Date.now();
console.log(`窗口：${horizons.join(", ")} 天`);
const written = ensureBaselines(db, horizons, { verbose: true });

for (const horizon of horizons) {
  const row = db
    .prepare(
      `SELECT COUNT(*) days, MIN(day) first_day, MAX(day) last_day,
              ROUND(AVG(item_count)) avg_items
       FROM market_baseline_daily WHERE horizon_days = ?`
    )
    .get(horizon);
  console.log(
    `窗口 ${horizon} 天：库里共 ${row.days} 天（${row.first_day ?? "-"} ~ ${row.last_day ?? "-"}），` +
      `平均每天 ${row.avg_items ?? 0} 个饰品参与，本次新增 ${written[horizon] ?? 0} 天`
  );
}
console.log(`耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
