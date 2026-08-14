// 把"当天全市场未来 N 天收益的中位数"算好存进 market_baseline_daily（迁移 023）。
//
// 用法（云端容器里跑）：
//   node scripts/build-market-baseline.mjs            # 主口径 7 天
//   node scripts/build-market-baseline.mjs 7 12 14    # 指定多个窗口（模拟盘按持有天数算）
//
// **这是三个评估脚本里唯一会写库的一个**，报告脚本一律只读——报告顺手写库的话，
// 同一份报告在不同时间跑会读到不同的缓存内容，出了问题分不清是数据变了还是缓存脏了。
// 增量：已经存过的 (天, 窗口) 不重算，价格只追加、定型之后不会变。
//
// ⚠️ **首次回填 / 一次补多个窗口时，不要直接对着生产库跑**（2026-08-13 的教训）：
// 这台 1 核 1GB 的机器上，一次补 7 个窗口会长时间占着写锁 + 打满磁盘，实测把常驻
// 采集器饿了 40 分钟——`price_snapshots` 一条没写、每小时同步和 10 分钟快速同步全部
// 停摆，而且**没有任何报错**（HANDOFF 踩坑 49）。正确做法是**对着副本跑再合并回去**：
//   node scripts/copy-db-for-analysis.mjs /tmp/analysis.sqlite      # 在线备份，不阻塞写入
//   CS2_DB_PATH=/tmp/analysis.sqlite node scripts/build-market-baseline.mjs 8 9 10 11 12 13
//   node scripts/merge-market-baseline.mjs /tmp/analysis.sqlite     # 一次短写事务合并回来
// 只补当天那一个窗口（日常增量）时数据量很小，直接对生产库跑没问题。
import Database from "better-sqlite3";
import {
  assertBaselineTable,
  baselineProvenance,
  BASELINE_CALC_VERSION,
  ensureBaselines,
  recordRegimeDaily,
} from "./market-baseline-store.mjs";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

// 原来这里是手写的 indexOf + filter，**没传 --throttle-ms 时会静默吃掉第一个窗口参数**
// （indexOf 返回 −1，`i !== throttleIdx + 1` 退化成 `i !== 0`）：`… 8 9 10 11 12 13 16`
// 实际只算了 9 起的六个，而且照样打印"窗口：9, 10, …"、照样成功退出。
// 现在统一走 scripts/script-args.mjs：不认识的参数直接报错退出 + 抬头回显实参。
const args = parseScriptArgs({
  name: "build-market-baseline",
  usage: "node scripts/build-market-baseline.mjs [窗口天数…] [--throttle-ms N]",
  booleans: ["--daily"],
  values: { "--throttle-ms": { parse: Number, default: 0, label: "让路毫秒" } },
  restNumbers: { name: "horizons", default: [7], label: "窗口天数" },
});
const throttleMs = args.values["--throttle-ms"];
const horizons = args.horizons;
// --daily：只补刚刚成熟的那几天，每个饰品只读边界附近几天而不是整段历史。
// 这条是为了让"每天补一次"能在生产库上直接跑而不触发踩坑 49——一天的量天然满足约束，
// 不必在"排定时"和"接受报告永远缺最新一天"之间二选一。首次回填/补历史仍然用全量模式。
const daily = args.booleans["--daily"];

const db = new Database(resolveDbPath(args.dbPath));
// builder 是**写入方**：新开一版口径时表里还没有这一版的行，这是正常的
assertBaselineTable(db, { requireCurrentVersion: false });

const startedAt = Date.now();
console.log(`窗口：${horizons.join(", ")} 天`);
if (throttleMs) console.log(`每个饰品之间让路 ${throttleMs}ms，给采集器留磁盘`);
const written = ensureBaselines(db, horizons, { verbose: true, throttleMs, daily });

// 顺带把每日采集规模记下来（迁移 025）。daily 模式只补最近几天，全量模式重算整表。
// 放在这个脚本里是因为**报告脚本一律只读**，写库的只有 builder 和 merge 两个。
const regimeFrom = daily ? new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10) : null;
const regimeDays = recordRegimeDaily(db, regimeFrom);
console.log(`[market-regime] 记录了 ${regimeDays} 天的采集规模${regimeFrom ? `（${regimeFrom} 起）` : "（全量）"}`);

for (const horizon of horizons) {
  const row = db
    .prepare(
      `SELECT COUNT(*) days, MIN(day) first_day, MAX(day) last_day,
              ROUND(AVG(item_count)) avg_items
       FROM market_baseline_daily WHERE horizon_days = ? AND calc_version = ?`
    )
    .get(horizon, BASELINE_CALC_VERSION);
  console.log(
    `窗口 ${horizon} 天：库里共 ${row.days} 天（${row.first_day ?? "-"} ~ ${row.last_day ?? "-"}），` +
      `平均每天 ${row.avg_items ?? 0} 个饰品参与，本次新增 ${written[horizon] ?? 0} 天`
  );
}
console.log("");
console.log(baselineProvenance(db));
console.log(`耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
