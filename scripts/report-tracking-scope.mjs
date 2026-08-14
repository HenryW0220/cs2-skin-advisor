// 被追踪饰品集合是怎么变化的，以及模拟盘开仓的集中度从哪来。
// 用法：node scripts/report-tracking-scope.mjs [库文件]
//
// 为什么要有这个脚本（2026-08-14）：HANDOFF 里 7-30 那次模拟盘归因写着
// "153 笔里 79 笔开在 7-26，那正是观察池从 41 扩到 282 的当天"。
// 而 report-regime-boundaries.mjs 实测显示 **7-26 当天 price_snapshots 的 distinct 饰品数
// 根本没动（325 → 325）**，动的只有行数（C5 提频，同样的饰品写得更勤）。
// 于是那个因果故事失去了支撑——**79 笔集中开仓这个现象是实测的、不变，但原因要重查**。
//
// ⚠️ 关键教训：`price_snapshots` 的 distinct 饰品数是**代理指标，不是被追踪集合**。
// 它把 K 线回填写进来的候选池也算了进去（7-17~7-21 那几天 673~746 个饰品就是证据，
// 回填一停立刻落回 325）。**一个看起来贴切、实际测的是另一个量的指标**——跟"拿全表平均
// 当基数""拿在售量当成交量"是同一族。被追踪集合的一手记录是 `watchlist.created_at`，
// 这个脚本查的是那个。
import Database from "better-sqlite3";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "report-tracking-scope",
  usage: "node scripts/report-tracking-scope.mjs [库文件]",
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const db = new Database(resolveDbPath(args.dbPath), { readonly: true });

// ---------- 一手记录：观察池条目按创建日 ----------
const added = db
  .prepare(
    `SELECT substr(created_at, 1, 10) day, COUNT(*) n FROM watchlist GROUP BY 1 ORDER BY 1`
  )
  .all();
const total = added.reduce((s, r) => s + r.n, 0);
console.log(`=== 观察池（watchlist）按加入日 —— 被追踪集合的一手记录 ===`);
console.log(`当前共 ${total} 条`);
let cumulative = 0;
for (const r of added) {
  cumulative += r.n;
  console.log(`  ${r.day}  +${String(r.n).padStart(4)}  累计 ${cumulative}`);
}

// ---------- 对照：快照里的 distinct 饰品数（代理指标）----------
console.log("");
console.log("=== 对照：price_snapshots 的每日 distinct 饰品数（代理指标，会把回填算进去）===");
const snapDays = db
  .prepare(
    `SELECT substr(captured_at, 1, 10) day, COUNT(DISTINCT item_name) items
     FROM price_snapshots WHERE captured_at >= '2026-07-15' GROUP BY 1 ORDER BY 1`
  )
  .all();
for (const r of snapDays) console.log(`  ${r.day}  ${r.items} 个`);

// ---------- 模拟盘开仓集中度 ----------
console.log("");
console.log("=== 模拟盘开仓按日 ===");
const opens = db
  .prepare(
    `SELECT substr(opened_at, 1, 10) day, COUNT(*) n, COUNT(DISTINCT item_name) items
     FROM paper_trades GROUP BY 1 ORDER BY 1`
  )
  .all();
const openTotal = opens.reduce((s, r) => s + r.n, 0);
for (const r of opens) {
  console.log(
    `  ${r.day}  ${String(r.n).padStart(4)} 笔 / ${String(r.items).padStart(4)} 个饰品` +
      `  占全部 ${((100 * r.n) / openTotal).toFixed(1)}%`
  );
}

// ---------- 把三者对齐，回答"集中开仓那天到底发生了什么" ----------
console.log("");
console.log("=== 对齐：开仓最集中的那天，观察池和快照各自发生了什么 ===");
const addedByDay = new Map(added.map((r) => [r.day, r.n]));
const snapByDay = new Map(snapDays.map((r) => [r.day, r.items]));
const topOpens = [...opens].sort((a, b) => b.n - a.n).slice(0, 5);
console.log("开仓日     | 开仓笔数 | 当天新加入观察池 | 当天快照 distinct 饰品数");
console.log("-----------|---------|-----------------|------------------------");
for (const r of topOpens) {
  console.log(
    `${r.day} | ${String(r.n).padStart(7)} | ${String(addedByDay.get(r.day) ?? 0).padStart(15)} | ` +
      `${String(snapByDay.get(r.day) ?? "—").padStart(22)}`
  );
}
console.log("");
console.log("读法：如果集中开仓那天**观察池没有新增**，那「扩容导致集中开仓」这个解释就不成立，");
console.log("      要去别处找原因（比如当天的行情让大量饰品同时满足入场条件、或者是补跑）。");

// ---------- 解释"观察池翻了 7 倍、快照 distinct 饰品数却纹丝不动" ----------
// 这两件事同时成立唯一的可能是：新加进观察池的那批**在加进来之前就已经在被采集了**
// （它们本来就在候选池里）。这一步是把这个推测**验掉**，不是让它当解释。
// 它同时解释了为什么扩容当天就能开出 79 笔：那批饰品已经有历史，信号立刻算得出来，
// 不需要等攒够数据。
const expansionDay = [...addedByDay.entries()].sort((a, b) => b[1] - a[1])[0];
if (expansionDay) {
  const [day, n] = expansionDay;
  const row = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM price_snapshots p
                    WHERE p.item_name = w.item_name AND p.captured_at < ?
                  ) THEN 1 ELSE 0 END) already_collected
       FROM watchlist w WHERE substr(w.created_at, 1, 10) = ?`
    )
    .get(`${day}T00:00:00.000Z`, day);
  console.log("");
  console.log(`=== ${day} 那批新增（${n} 条）在加进观察池之前，是不是已经在采集了 ===`);
  console.log(
    `  ${row.already_collected}/${row.total} 条在 ${day} 之前就已经有价格快照` +
      `（${((100 * row.already_collected) / row.total).toFixed(1)}%）`
  );
  console.log(
    "  这一条同时解释两件事：① 观察池翻了几倍而快照 distinct 饰品数纹丝不动——本来就在采；"
  );
  console.log(
    "  ② 扩容当天就能开出大量仓位——那批饰品已经有历史，信号立刻算得出来，不用等攒数据。"
  );
}
