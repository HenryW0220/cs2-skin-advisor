// 压测 report-paper-trades.mjs 的超额基准段（marketReturn）。只读，不写任何东西。
// 用法：node scripts/stress-market-baseline.mjs [窗口数]（云端容器里跑，默认 20）
//
// 为什么单独压这一段：report-paper-trades.mjs 至今只在构造的 12 笔样本库上跑过，
// 真库 0 平仓、主体一行没执行过。而基准段要在真库上算"全市场同窗口中位数收益"，
// 是唯一一段会碰**全表**的代码。8-21 起才有真实平仓数据，那天第一次跑才发现
// 跑不完就晚了——所以提前用人造时间窗口把这一段单独压出来。
//
// ---- 2026-08-03 实测结论（结论写在这里，免得以后有人重跑一遍才知道）----
// **单次调用中位 26.7 秒**（20 次：最快 20.6s、最慢 46.0s，总 570s）。
// RSS 峰值只有 56.5MiB——**所以这不是踩坑 28 那种内存问题，是纯粹的时间问题**，
// 两者的止血手段完全不同，别套错。
//
// 根因看查询计划就清楚：`SCAN a USING INDEX sqlite_autoindex_price_snapshots_1`。
// 那个 UNIQUE 索引是 (item_name, platform, captured_at)，而这段查询只按 captured_at
// 过滤——**captured_at 排在第三列，range 条件用不上索引前缀**，只能整索引扫一遍
// （191 万条）。库里另一个索引 (item_name, captured_at) 同理，也没有以 captured_at 打头的。
// 相关子查询那半反而是快的（item_name+platform+captured_at 全都能用上）。
//
// **多久算一次取决于有多少个不同的 (开仓日 × 持有天数) 组合，不是有多少笔平仓**
// （脚本按这个 key 缓存）。实测当前 231 笔 open 仓只分布在 **11 个开仓日**上，所以：
//   · 全部走 30 天超时平仓 → heldDays 恒为 30 → 只有 11 个组合 → **约 5 分钟**，能忍；
//   · v2 真的开始在不同时点触发 → 最坏 11 × 24 = 264 个组合 → **约 118 分钟**，不能忍。
// **也就是说这段代码恰好在实验开始奏效的那一刻变得最慢**——全部超时（= 卖出规则一次没触发，
// 最没信息量的那种结局）反而是最快的。别被"现在跑得动"骗过去。
//
// 两条出路（都还没做，等项目所有者定）：
//   ① 加一条 captured_at 打头的索引——治本，但要写迁移、要给 191 万行建索引，
//      而且会让每次写入多维护一个索引（C5 高频 tick 每 10 分钟写一批）；
//   ② **把基准改成一次性预聚合**——`build-sell-rule-baseline.mjs` 就是这么干的：
//      整个市场基准在**一遍**扫描里按天算完，而不是每个 (开仓日,持有天数) 组合查一次。
//      不用动数据库，改的是脚本自己。看起来是更对的那条路。
import Database from "better-sqlite3";

const db = new Database("data/db.sqlite", { readonly: true });
const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
const PRICE_TOLERANCE_MS = 6 * HOUR_MS;
const MIN_MARKET_SAMPLES = 20;
const N_WINDOWS = Number(process.argv[2] ?? 20);

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// —— 跟 report-paper-trades.mjs 的 marketReturn 逐字一致 ——
const SQL = `SELECT a.item_name, a.platform, a.price p0, (
         SELECT b.price FROM price_snapshots b
         WHERE b.item_name = a.item_name AND b.platform = a.platform AND b.price > 0
           AND b.captured_at >= ? AND b.captured_at < ?
         ORDER BY b.captured_at ASC LIMIT 1
       ) p1
       FROM price_snapshots a
       WHERE a.captured_at >= ? AND a.captured_at < ? AND a.price > 0
       GROUP BY a.item_name, a.platform`;

const total = db.prepare("SELECT COUNT(*) c FROM price_snapshots").get().c;
const range = db.prepare("SELECT MIN(captured_at) a, MAX(captured_at) b FROM price_snapshots").get();
console.log(`price_snapshots 总行数：${total.toLocaleString()}`);
console.log(`时间范围：${range.a} ~ ${range.b}`);
console.log("");
console.log("=== 查询计划（看它是走索引还是全表扫）===");
for (const r of db.prepare("EXPLAIN QUERY PLAN " + SQL).all("x", "x", "x", "x")) {
  console.log("  ", r.detail);
}
console.log("");
console.log("索引情况：");
for (const r of db.prepare("PRAGMA index_list(price_snapshots)").all()) {
  const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(r.name)})`).all().map((c) => c.name);
  console.log(`   ${r.name}  (${cols.join(", ")})${r.unique ? "  UNIQUE" : ""}`);
}

// —— 人造时间窗口：在真实数据区间里等距取 N 天，横跨整段历史 ——
const lo = Date.parse(range.a);
const hi = Date.parse(range.b) - 8 * DAY_MS; // 留出 7 天前瞻
const stmt = db.prepare(SQL);

console.log("");
console.log(`=== 压测：${N_WINDOWS} 个人造窗口（等距铺满整段历史，模拟平仓分散在不同开仓日）===`);
console.log("窗口日期     | 持有天数 | 分组数 | 有效样本 | 中位收益  | 耗时");
console.log("-------------|---------|-------|---------|----------|--------");

let peakRss = 0;
const timings = [];
const sampleRss = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};

const t0 = Date.now();
for (let i = 0; i < N_WINDOWS; i++) {
  const day = Math.floor((lo + ((hi - lo) * i) / Math.max(1, N_WINDOWS - 1)) / DAY_MS) * DAY_MS;
  // 持有天数在 7~30 之间变化：真实平仓的 heldDays 各不相同，
  // 每个不同的 (day, horizon) 组合都是一次全新的查询，缓存挡不住
  const horizon = 7 + (i % 24);

  const t = Date.now();
  const rows = stmt.all(
    new Date(day + horizon * DAY_MS).toISOString(),
    new Date(day + horizon * DAY_MS + PRICE_TOLERANCE_MS).toISOString(),
    new Date(day).toISOString(),
    new Date(day + DAY_MS).toISOString()
  );
  const rets = rows.filter((r) => r.p1 > 0 && r.p0 > 0).map((r) => (r.p1 - r.p0) / r.p0);
  const value = rets.length >= MIN_MARKET_SAMPLES ? median(rets) : null;
  const ms = Date.now() - t;
  timings.push(ms);
  sampleRss();

  console.log(
    `${new Date(day).toISOString().slice(0, 10)}   | ${String(horizon).padStart(7)} | ` +
      `${String(rows.length).padStart(5)} | ${String(rets.length).padStart(7)} | ` +
      `${value === null ? "  样本不足" : (value * 100).toFixed(2).padStart(7) + "%"} | ${String(ms).padStart(5)}ms`
  );
}
const totalMs = Date.now() - t0;

timings.sort((a, b) => a - b);
console.log("");
console.log("=== 结果 ===");
console.log(`总耗时 ${(totalMs / 1000).toFixed(1)}s，单次中位 ${timings[Math.floor(timings.length / 2)]}ms、` +
  `最慢 ${timings[timings.length - 1]}ms、最快 ${timings[0]}ms`);
console.log(`进程 RSS 峰值 ${(peakRss / 1048576).toFixed(1)}MiB（容器上限 954MiB，Node 默认堆上限约 477MiB）`);
console.log(`堆已用 ${(process.memoryUsage().heapUsed / 1048576).toFixed(1)}MiB`);
console.log("");
const perCall = timings[Math.floor(timings.length / 2)];
console.log("外推（每个不同的「开仓日 × 持有天数」组合都要跑一次，脚本里按这个 key 缓存）：");
for (const n of [30, 100, 230]) {
  console.log(`   ${String(n).padStart(3)} 个不同组合 → 约 ${((n * perCall) / 1000).toFixed(0)}s`);
}
console.log("");
console.log("读法：230 是当前 open 仓位总数，也就是**最坏情况下的不同组合数上限**");
console.log("（每笔仓位开仓日和持有天数都不一样时取到）。如果这个数字到了分钟级，");
console.log("8-21 那天第一次跑报告就会卡住，要么加索引要么把基准改成按天预聚合一次。");
