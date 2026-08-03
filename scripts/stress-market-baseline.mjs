// 压测 report-paper-trades.mjs 的超额基准段（marketReturn）。只读，不写任何东西。
// 用法：node scripts/stress-market-baseline.mjs [窗口数]（云端容器里跑，默认 20）
//
// 为什么单独压这一段：report-paper-trades.mjs 至今只在构造的 12 笔样本库上跑过，
// 真库 0 平仓、主体一行没执行过。而基准段要在真库上算"全市场同窗口中位数收益"，
// 是唯一一段会碰**全表**的代码。8-21 起才有真实平仓数据，那天第一次跑才发现
// 跑不完就晚了——所以提前用人造时间窗口把这一段单独压出来。
//
// ---- 2026-08-03 第一版实测（改造前）----
// **单次调用中位 26.7 秒**（20 次：最快 20.6s、最慢 46.0s，总 570s）。
// RSS 峰值只有 56.5MiB——**所以这不是踩坑 28 那种内存问题，是纯粹的时间问题**，
// 两者的止血手段完全不同，别套错。
//
// 根因看查询计划就清楚：`SCAN a USING INDEX sqlite_autoindex_price_snapshots_1`。
// 那个 UNIQUE 索引是 (item_name, platform, captured_at)，而这段查询只按 captured_at
// 过滤——**captured_at 排在第三列，range 条件用不上索引前缀**，只能整索引扫一遍
// （191 万条）。库里另一个索引 (item_name, captured_at) 同理。
// 相关子查询那半反而是快的（item_name+platform+captured_at 全都能用上）。
//
// ---- 2026-08-03 第二版：按窗口记忆化（本脚本现在测的就是这一版）----
// 关键观察：**外层那个昂贵的扫描只跟"开仓日"有关，跟"持有天数"无关**。原来两者绑在
// 一条 SQL 里，同一个开仓日配 24 种持有天数就要重复扫 24 遍完全相同的窗口。
// 拆开后：开仓日窗口按 [起始,结束] 缓存（每个开仓日只扫一次），未来价改走逐饰品点查
// （能用上索引，本来就快）。**所以省下多少完全取决于窗口重不重复**——
// 下面两个场景一个是最坏情况一个是真实形状，两个都报，不挑好看的报。
//
// ---- 2026-08-03 改造后实测（191 万行、1 核 1GB 云端容器）----
//   最坏情况（20 个互不相同的开仓日，缓存全不命中）：27.79s/次，总 556s
//     → **跟改造前 26.7s/次 基本持平**。窗口不重复时记忆化一次都省不掉，这在意料之中，
//       写出来是为了别把改造效果说过头。
//   真实形状（11 个真实开仓日 × 持有 7~30 天 = 264 个组合）：**1.25s/次，总 331s**
//     → 264 次调用只触发 **11 次窗口扫描**；单次中位 **8ms**（缓存命中），最慢 40.9s（冷扫）。
//       **对比改造前同规模估算的约 117 分钟 → 5.5 分钟，约 21 倍。**
//   RSS 峰值 76.3MiB，仍然远离内存上限——这一段从头到尾都不是内存问题。
// **结论：真实工作负载已经够用了；最坏场景要治只有加 captured_at 打头的索引。**
import Database from "better-sqlite3";

const db = new Database(process.argv[2] ?? "data/db.sqlite", { readonly: true });
const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
const PRICE_TOLERANCE_MS = 6 * HOUR_MS;
const MIN_MARKET_SAMPLES = 20;
const N_WINDOWS = Number(process.argv[3] ?? 20);

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// ---- 与 report-paper-trades.mjs 改造后的实现逐字一致 ----
const windowCache = new Map();
const windowStmt = db.prepare(
  `SELECT item_name, platform, price, MIN(captured_at) AS first_at
   FROM price_snapshots
   WHERE captured_at >= ? AND captured_at < ? AND price > 0
   GROUP BY item_name, platform`
);
let windowScans = 0;
function pricesInWindow(startIso, endIso) {
  const key = `${startIso}|${endIso}`;
  const hit = windowCache.get(key);
  if (hit) return hit;
  windowScans += 1;
  const rows = windowStmt.all(startIso, endIso);
  windowCache.set(key, rows);
  return rows;
}

const futurePriceStmt = db.prepare(
  `SELECT price FROM price_snapshots
   WHERE item_name = ? AND platform = ? AND price > 0
     AND captured_at >= ? AND captured_at < ?
   ORDER BY captured_at ASC LIMIT 1`
);

const marketCache = new Map();
function marketReturn(fromMs, horizonDays) {
  const day = Math.floor(fromMs / DAY_MS) * DAY_MS;
  const key = `${day}|${horizonDays}`;
  if (marketCache.has(key)) return marketCache.get(key);
  const base = pricesInWindow(new Date(day).toISOString(), new Date(day + DAY_MS).toISOString());
  const futureStart = day + horizonDays * DAY_MS;
  const fromIso = new Date(futureStart).toISOString();
  const toIso = new Date(futureStart + PRICE_TOLERANCE_MS).toISOString();
  const rets = [];
  for (const r of base) {
    const f = futurePriceStmt.get(r.item_name, r.platform, fromIso, toIso);
    if (f && f.price > 0 && r.price > 0) rets.push((f.price - r.price) / r.price);
  }
  const value = rets.length >= MIN_MARKET_SAMPLES ? median(rets) : null;
  marketCache.set(key, value);
  return value;
}

// ---------- 环境信息 ----------
const total = db.prepare("SELECT COUNT(*) c FROM price_snapshots").get().c;
const range = db.prepare("SELECT MIN(captured_at) a, MAX(captured_at) b FROM price_snapshots").get();
console.log(`price_snapshots 总行数：${total.toLocaleString()}`);
console.log(`时间范围：${range.a} ~ ${range.b}`);
console.log("");
console.log("=== 开仓日窗口查询的计划（这是唯一昂贵的一段）===");
for (const r of db.prepare("EXPLAIN QUERY PLAN " + windowStmt.source).all("x", "x")) {
  console.log("  ", r.detail);
}
console.log("=== 未来价点查的计划（对照：这段本来就快）===");
for (const r of db.prepare("EXPLAIN QUERY PLAN " + futurePriceStmt.source).all("x", "x", "x", "x")) {
  console.log("  ", r.detail);
}

let peakRss = 0;
const sampleRss = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};

function runScenario(label, combos, note) {
  windowCache.clear();
  marketCache.clear();
  windowScans = 0;
  console.log("");
  console.log(`=== 场景：${label} ===`);
  console.log(note);
  const timings = [];
  const t0 = Date.now();
  for (const [day, horizon] of combos) {
    const t = Date.now();
    marketReturn(day, horizon);
    timings.push(Date.now() - t);
    sampleRss();
  }
  const totalMs = Date.now() - t0;
  timings.sort((a, b) => a - b);
  const distinctDays = new Set(combos.map(([d]) => Math.floor(d / DAY_MS))).size;
  console.log(
    `调用 ${combos.length} 次（${distinctDays} 个不同开仓日）→ 实际扫描窗口 ${windowScans} 次`
  );
  console.log(
    `总耗时 ${(totalMs / 1000).toFixed(1)}s；单次中位 ${timings[Math.floor(timings.length / 2)]}ms、` +
      `最慢 ${timings[timings.length - 1]}ms、最快 ${timings[0]}ms`
  );
  console.log(`平均每次 ${(totalMs / combos.length / 1000).toFixed(2)}s —— 对比改造前 **26.7s/次**`);
  return { totalMs, perCall: totalMs / combos.length };
}

const lo = Date.parse(range.a);
const hi = Date.parse(range.b) - 8 * DAY_MS;

// 场景 A：跟改造前那次压测**完全相同**的 20 个窗口——每个都是不同的开仓日，
// 缓存一次都命中不了。这是最坏情况，报它是为了不让改造效果被"挑了个好场景"撑起来。
const worstCombos = [];
for (let i = 0; i < N_WINDOWS; i++) {
  const day = Math.floor((lo + ((hi - lo) * i) / Math.max(1, N_WINDOWS - 1)) / DAY_MS) * DAY_MS;
  worstCombos.push([day, 7 + (i % 24)]);
}
const worst = runScenario(
  "最坏情况（20 个互不相同的开仓日，缓存全不命中）",
  worstCombos,
  "跟改造前那次压测用的是同一批窗口，可直接对比。窗口不重复时按窗口缓存救不了，只能靠索引。"
);

// 场景 B：真实形状——实测 231 笔仓位只分布在 11 个开仓日上，
// v2 若在不同时点触发，就是"11 个开仓日 × 多种持有天数"。这才是 8-21 那天会发生的事。
const realDays = db
  .prepare("SELECT DISTINCT substr(opened_at,1,10) d FROM paper_trades WHERE status='open' ORDER BY d")
  .all()
  .map((r) => Date.parse(`${r.d}T00:00:00.000Z`));
let real = null;
if (realDays.length) {
  const realCombos = [];
  for (const d of realDays) for (let h = 7; h <= 30; h++) realCombos.push([d, h]);
  real = runScenario(
    `真实形状（${realDays.length} 个真实开仓日 × 持有 7~30 天 = ${realDays.length * 24} 个组合）`,
    realCombos,
    "这是 v2 真的开始在不同时点触发时会发生的事——改造前估算约 118 分钟。"
  );
}

console.log("");
console.log("=== 结果 ===");
console.log(`进程 RSS 峰值 ${(peakRss / 1048576).toFixed(1)}MiB（容器上限 954MiB）`);
console.log("");
console.log("场景                     | 调用次数 | 总耗时 | 每次平均 | 改造前同规模估算");
console.log("-------------------------|---------|--------|---------|------------------");
console.log(
  `最坏（窗口全不重复）        | ${String(worstCombos.length).padStart(7)} | ` +
    `${(worst.totalMs / 1000).toFixed(0).padStart(5)}s | ${(worst.perCall / 1000).toFixed(2).padStart(6)}s | ` +
    `${((worstCombos.length * 26.7) / 60).toFixed(0)} 分钟`
);
if (real) {
  const n = realDays.length * 24;
  console.log(
    `真实形状（${String(realDays.length).padStart(2)} 开仓日 × 24）      | ${String(n).padStart(7)} | ` +
      `${(real.totalMs / 1000).toFixed(0).padStart(5)}s | ${(real.perCall / 1000).toFixed(2).padStart(6)}s | ` +
      `${((n * 26.7) / 60).toFixed(0)} 分钟`
  );
}
console.log("");
console.log("读法：**按窗口记忆化只能省掉重复的窗口**——最坏场景里每个开仓日都不同，一次都省不掉，");
console.log("      耗时跟改造前基本持平（能省的只是原来每次都要跑的那几百条相关子查询）。");
console.log("      真实形状里 11 个开仓日撑起几百个组合，省掉的就是绝大部分。");
console.log("      **要连最坏场景也治好，只有加 captured_at 打头的索引那条路。**");
