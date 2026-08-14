// 数据库查询计时。用法：node scripts/bench.mjs（云端容器里跑）
//
// 写于 2026-07-21 排查页面卡顿时，按踩坑 25「先量再改」的要求做基线测量用的。
// 一直只存在于服务器上没进 git，2026-08-03 补进来（踩坑 21 的第三次复现）。
//
// 测的是三条最容易变慢的读路径，都是"遍历全部追踪饰品"的批处理循环会反复调的：
//   getLatestPricesByPlatform  —— 跨平台价差、参考平台选择
//   getPriceHistory(全量)      —— 只剩详情页"全部"区间和历史回扫在用，
//                                 信号计算已改走 getRecentPriceHistory（21 天窗口）
// 外加查询计划和行数，用来判断慢是"缺索引"还是"数据量本身涨了"——
// 这两种的处理方式完全不同（踩坑 28：OOM 那次是后者，加索引没用）。
//
// **只读打开**：原版是读写模式开生产库的，跑一个测量脚本没有任何理由持有写锁。
import Database from "better-sqlite3";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "bench",
  usage: "node scripts/bench.mjs [库文件]",
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const db = new Database(resolveDbPath(args.dbPath), { readonly: true });

const item = db.prepare("SELECT item_name FROM inventory WHERE buy_price > 0 LIMIT 1").get();
if (!item) {
  console.log("inventory 里没有 buy_price>0 的饰品，测不了。");
  process.exit(0);
}
console.log("测试饰品:", item.item_name);

const t1 = Date.now();
const latest = db
  .prepare(
    `SELECT ps.* FROM price_snapshots ps
     JOIN (
       SELECT platform, MAX(captured_at) AS max_captured_at
       FROM price_snapshots WHERE item_name = ? GROUP BY platform
     ) latest
       ON ps.platform = latest.platform AND ps.captured_at = latest.max_captured_at
     WHERE ps.item_name = ?`
  )
  .all(item.item_name, item.item_name);
console.log("getLatestPricesByPlatform 耗时:", Date.now() - t1, "ms, 行数:", latest.length);

const t2 = Date.now();
const history = db
  .prepare("SELECT * FROM price_snapshots WHERE item_name = ? AND platform = ? ORDER BY captured_at ASC")
  .all(item.item_name, "C5");
console.log("getPriceHistory(C5) 耗时:", Date.now() - t2, "ms, 行数:", history.length);

const plan = db
  .prepare("EXPLAIN QUERY PLAN SELECT * FROM price_snapshots WHERE item_name = ? AND platform = ? ORDER BY captured_at ASC")
  .all(item.item_name, "C5");
console.log("查询计划:", JSON.stringify(plan));

const totalRows = db.prepare("SELECT COUNT(*) as c FROM price_snapshots").get();
console.log("price_snapshots 总行数:", totalRows.c);

const t3 = Date.now();
const rowsForItem = db.prepare("SELECT COUNT(*) as c FROM price_snapshots WHERE item_name = ?").get(item.item_name);
console.log("该饰品总行数:", rowsForItem.c, "查询耗时:", Date.now() - t3, "ms");
