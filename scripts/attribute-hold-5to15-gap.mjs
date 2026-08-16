// 归因：影子里 HOLD 的 5~15% 那段为什么比回测负一倍。用法：
//   node scripts/attribute-hold-5to15-gap.mjs [库文件]
//
// **只读。这一轮只做归因，不改任何阈值——无论结果多好看。**（项目所有者 2026-08-16 预先声明）
//
// ============================================================================
// 为什么这一条值得单独立项
// ============================================================================
// v2 对 24h 涨幅 5~15% 的处理是"**明确不触发**"（判定为经济上不显著：回测超额只有
// −2.75% / −3.17%，扣掉 6.7% 的往返成本不值得换手）。
// 2026-08-16 的影子报告里，这一段**第一次跨过脚本自己的样本门槛**（≥30 条可评估且 ≥10 个饰品）：
// **60 条 / 54 个饰品 / 超额中位 −6.37% / 为负占比 83.3%**，比回测同档负一倍、且贴近成本线。
//
// **这是这几周第一条越过门槛、且指向改生产规则的实盘证据**——前面所有工作要么是基础设施，
// 要么结论是"不可行动"。**也正因为如此，它是最容易被我们自己的期待污染的一条。**
//
// ============================================================================
// 三个问题，顺序是定死的
// ============================================================================
// **Q1 10~15% 那档只有 8 个饰品，是不是在拉高整体？** 最便宜也最可能推翻结论。
//    把 5~10%（46 品）单独拿出来看：它自己够不够得着；去掉 10~15% 之后整体变浅多少。
//    这跟 REPORT-t7-actionable-labels 那次"去掉贡献最大的 5 个饰品，+41.6% 掉到 +7.67%"
//    是同一个形状。
//
// **Q2 实盘比回测负一倍，是口径差异还是市场变了？** 两种解释的后续动作完全相反。
//    **先查口径，再谈市场**——顺序反了会先构造出一个市场故事，然后停止找 bug。
//    影子样本相对回测有两个已知的系统性差异：
//      · **总体不同**：回测是 714 个饰品的全市场，影子只覆盖模拟盘持有的那 258 个品；
//      · **区间不同**：回测跨 99~111 天（含 2026-04~06 那段未解释 régime），影子全部在 8 月。
//    所以做一个 2×2 分解：把**回测口径**分别限制到「影子的饰品集合」×「影子的日期区间」，
//    看四个格子。**如果限制到同样的总体和区间之后回测也变成 −6% 上下，那差异就是口径不是市场。**
//    第三项：**定义是否一致**——`shadow_sell_signals` 存了生产当时算的 `return_24h`，
//    拿它跟本脚本按回测口径重算的值逐条比。**这是一次真正的"生产 vs 回测"等价性验证**
//    （第四节 0.5 那条待办的清单里，24h 涨幅正是没核对过的一项；能做是因为影子表恰好留了痕）。
//
// **Q3 这 60 条跟 v2 真正在验的那 3 条是什么关系？** 影子里 SELL 只有 12 条、SELL_STRONG 1 条，
//    可评估的更少；而这 60 条是 HOLD。**我们盯着的和数据给的不是同一处**，要写进报告。
import Database from "better-sqlite3";
import { assertBaselineTable, baselineProvenance, loadBaseline } from "./market-baseline-store.mjs";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "attribute-hold-5to15-gap",
  usage: "node scripts/attribute-hold-5to15-gap.mjs [库文件]",
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const db = new Database(resolveDbPath(args.dbPath), { readonly: true });

const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
// 跟 build-sell-rule-baseline.mjs 逐条对齐——这个脚本的全部意义是拿回测口径去量影子样本，
// 口径一动就量不出差异了
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const MIN_SNAPSHOTS_PER_ITEM = 200;
const HORIZON_DAYS = 7;
const HISTORY_GATE_HOURS = 24 * (HORIZON_DAYS + 14);
const COST_MIN = 0.067; // lib/rules/cost-line.ts ROUND_TRIP_COST_MIN

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctNeg = (a) => (a.length ? a.filter((v) => v < 0).length / a.length : NaN);
const fmt = (v) => (Number.isNaN(v) || v === undefined ? "   -   " : (v * 100).toFixed(2).padStart(6) + "%");

function signTestP(hits, total) {
  if (!total) return NaN;
  const logC = (n, k) => {
    let s = 0;
    for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1);
    return s;
  };
  let logSum = -Infinity;
  for (let i = hits; i <= total; i++) {
    const l = logC(total, i);
    logSum = logSum === -Infinity ? l : Math.max(logSum, l) + Math.log(1 + Math.exp(-Math.abs(logSum - l)));
  }
  return Math.exp(logSum - total * Math.log(2));
}

function referencePlatform(itemName) {
  const rows = db
    .prepare(
      `SELECT platform, COUNT(*) n FROM price_snapshots
       WHERE item_name = ? AND price > 0 GROUP BY platform ORDER BY n DESC`
    )
    .all(itemName);
  for (const p of PLATFORM_PRIORITY) {
    const hit = rows.find((r) => r.platform === p);
    if (hit && hit.n >= MIN_SNAPSHOTS_PER_ITEM) return p;
  }
  return rows[0]?.n >= MIN_SNAPSHOTS_PER_ITEM ? rows[0].platform : null;
}

function hourlySeries(itemName, platform) {
  const rows = db
    .prepare(
      `SELECT captured_at, price FROM price_snapshots
       WHERE item_name = ? AND platform = ? AND price > 0 ORDER BY captured_at ASC`
    )
    .all(itemName, platform);
  const byHour = new Map();
  for (const r of rows) byHour.set(Math.floor(Date.parse(r.captured_at) / HOUR_MS) * HOUR_MS, r.price);
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]);
}

assertBaselineTable(db);
const baseline = loadBaseline(db, HORIZON_DAYS);
if (!baseline.size) {
  console.log("没有基准，先跑 build-market-baseline.mjs");
  process.exit(0);
}
console.log(baselineProvenance(db));
console.log("");
const marketByDay = new Map([...baseline.entries()].map(([d, v]) => [d, v.median]));

// ============================================================================
// 取影子样本：HOLD 且 24h 涨幅落在 5~15%
// ============================================================================
const shadowRows = db
  .prepare(
    `SELECT item_name, platform, action, price, return_24h, decided_at
     FROM shadow_sell_signals
     WHERE rule_version = 'v2' AND return_24h IS NOT NULL`
  )
  .all();

const seriesCache = new Map();
function seriesFor(item, platform) {
  const key = `${item}|${platform}`;
  if (!seriesCache.has(key)) seriesCache.set(key, hourlySeries(item, platform));
  return seriesCache.get(key);
}

/** 按回测口径给一个 (饰品, 时刻) 算 T+7 超额；算不出返回 null 并带上原因 */
function excessAt(item, platform, tsMs) {
  const series = seriesFor(item, platform);
  if (series.length < HISTORY_GATE_HOURS) return { err: "历史不足" };
  const idx = new Map(series.map(([h], i) => [h, i]));
  const hour = Math.floor(tsMs / HOUR_MS) * HOUR_MS;
  const i = idx.get(hour);
  if (i === undefined) return { err: "决策时刻无快照" };
  const f = idx.get(hour + HORIZON_DAYS * DAY_MS);
  if (f === undefined) return { err: "未到期/无 T+7 价" };
  const day = Math.floor(hour / DAY_MS) * DAY_MS;
  const base = marketByDay.get(day);
  if (base === undefined) return { err: "缺基准" };
  const fwd = (series[f][1] - series[i][1]) / series[i][1];
  return { excess: fwd - base, fwd, base, price: series[i][1], idx: i, series };
}

const holdSamples = []; // {item, ret24, excess, band}
const errCount = new Map();
for (const r of shadowRows) {
  if (r.action !== "HOLD") continue;
  if (!(r.return_24h >= 0.05 && r.return_24h < 0.15)) continue;
  const out = excessAt(r.item_name, r.platform, Date.parse(r.decided_at));
  if (out.err) {
    errCount.set(out.err, (errCount.get(out.err) ?? 0) + 1);
    continue;
  }
  holdSamples.push({
    item: r.item_name,
    ret24: r.return_24h,
    excess: out.excess,
    band: r.return_24h < 0.1 ? "5~10%" : "10~15%",
  });
}

const shadowItems = new Set(holdSamples.map((s) => s.item));
const shadowDays = holdSamples.map((s) => s.item); // placeholder
const shadowDayRange = (() => {
  const ds = shadowRows
    .filter((r) => r.action === "HOLD" && r.return_24h >= 0.05 && r.return_24h < 0.15)
    .map((r) => Date.parse(r.decided_at));
  return ds.length ? [Math.min(...ds), Math.max(...ds)] : [null, null];
})();

console.log("影子样本（HOLD 且 24h 涨幅 5~15%）");
console.log(`  可评估 ${holdSamples.length} 条、${shadowItems.size} 个饰品`);
if (shadowDayRange[0]) {
  console.log(
    `  决策时刻区间 ${new Date(shadowDayRange[0]).toISOString().slice(0, 10)} ~ ${new Date(shadowDayRange[1]).toISOString().slice(0, 10)}`
  );
}
if (errCount.size) {
  console.log(`  剔除：${[...errCount.entries()].map(([k, v]) => `${k} ${v} 条`).join("、")}`);
}
console.log("");

// ============================================================================
// Q1：10~15% 那 8 个饰品是不是在拉高整体
// ============================================================================
console.log("=== Q1：10~15% 那一档是不是在拉高整体 ===");
console.log("（最便宜也最可能推翻结论的一步。跟 REPORT-t7-actionable-labels 那次");
console.log("  「去掉贡献最大的 5 个饰品，+41.6% 掉到 +7.67%」是同一个形状。）");
console.log("");
console.log("子档     | 可评估 | 饰品数 | 超额中位数 | 为负占比 | 饰品中位数的中位 | 中位为负的饰品 | 符号p  | 最大单品占比");
console.log("---------|--------|--------|-----------|---------|------------------|---------------|--------|------------");
function describeSet(label, rows) {
  if (!rows.length) {
    console.log(`${label.padEnd(8)} | ${"0".padStart(6)} | ${"-".padStart(6)} | ${"   -   "} | ${"   -   "} | ${"   -   ".padStart(16)} | ${"-".padStart(13)} | ${"-".padStart(6)} | ${"-"}`);
    return null;
  }
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.item)) byItem.set(r.item, []);
    byItem.get(r.item).push(r.excess);
  }
  const itemMeds = [...byItem.values()].map(median);
  const neg = itemMeds.filter((v) => v < 0).length;
  const top = Math.max(...[...byItem.values()].map((v) => v.length)) / rows.length;
  const all = rows.map((r) => r.excess);
  console.log(
    `${label.padEnd(8)} | ${String(rows.length).padStart(6)} | ${String(byItem.size).padStart(6)} | ` +
      `${fmt(median(all))} | ${fmt(pctNeg(all))} | ${fmt(median(itemMeds)).padStart(16)} | ` +
      `${String(neg).padStart(9)}/${String(itemMeds.length).padStart(3)} | ${signTestP(neg, itemMeds.length).toFixed(4)} | ${(top * 100).toFixed(1)}%`
  );
  return { median: median(all), items: byItem.size };
}
const s510 = describeSet("5~10%", holdSamples.filter((s) => s.band === "5~10%"));
const s1015 = describeSet("10~15%", holdSamples.filter((s) => s.band === "10~15%"));
const sAll = describeSet("5~15%", holdSamples);
console.log("");
if (s510 && sAll) {
  const drop = s510.median - sAll.median;
  console.log(
    `**Q1 读数**：去掉 10~15% 之后，5~10% 单独是 ${fmt(s510.median)}（${s510.items} 个饰品），` +
      `整体是 ${fmt(sAll.median)}，差 ${(drop * 100).toFixed(2)}pp。`
  );
  console.log(
    `  · 5~10% 单独距 6.7% 成本线还差 ${((COST_MIN - Math.abs(s510.median)) * 100).toFixed(2)}pp` +
      `（负号方向，看的是幅度）。`
  );
  console.log("  · 如果 5~10% 自己就接近整体 ⇒ 结论不依赖那一小撮；");
  console.log("    如果去掉之后明显变浅 ⇒ −6.37% 是被一个 n 很小的格子拉起来的，跟孤例主导同形。");
}
console.log("");

// ============================================================================
// Q2-口径：2×2 分解（总体 × 区间）
// ============================================================================
console.log("=== Q2（先口径）：把回测口径限制到影子的总体和区间，看差异还在不在 ===");
console.log("影子相对回测有两个已知的系统性差异：**总体**（714 全市场 vs 持仓 258 品）和");
console.log("**区间**（99~111 天含未解释 régime vs 全部 8 月）。先看这两个能解释多少。");
console.log("");

const allItems = db.prepare("SELECT DISTINCT item_name FROM price_snapshots").all().map((r) => r.item_name);
const augFrom = Date.parse("2026-08-01T00:00:00.000Z");

/** 按回测口径全量扫，收集 5~10% / 10~15% 两档的样本；itemFilter/时间过滤可选 */
function backtestBand(itemFilter, sinceMs) {
  const out = { "5~10%": [], "10~15%": [] };
  for (const item of allItems) {
    if (itemFilter && !itemFilter.has(item)) continue;
    const platform = referencePlatform(item);
    if (!platform) continue;
    const series = seriesFor(item, platform);
    if (series.length < HISTORY_GATE_HOURS) continue;
    const idx = new Map(series.map(([h], i) => [h, i]));
    for (let i = 24; i < series.length; i++) {
      const [ts, price] = series[i];
      if (sinceMs !== null && ts < sinceMs) continue;
      const prev = series[i - 24]?.[1];
      if (!prev || prev <= 0) continue;
      const r24 = (price - prev) / prev;
      const band = r24 >= 0.05 && r24 < 0.1 ? "5~10%" : r24 >= 0.1 && r24 < 0.15 ? "10~15%" : null;
      if (!band) continue;
      const f = idx.get(ts + HORIZON_DAYS * DAY_MS);
      if (f === undefined) continue;
      const day = Math.floor(ts / DAY_MS) * DAY_MS;
      const base = marketByDay.get(day);
      if (base === undefined) continue;
      out[band].push({ item, excess: (series[f][1] - price) / price - base });
    }
  }
  return out;
}

const cells = [
  ["① 全市场 × 全区间（= 已发布的回测）", null, null],
  ["② 全市场 × 只 8 月", null, augFrom],
  ["③ 只影子饰品 × 全区间", shadowItems, null],
  ["④ 只影子饰品 × 只 8 月", shadowItems, augFrom],
];
console.log("格子                              | 档位   | 样本数 | 饰品数 | 超额中位数 | 为负占比");
console.log("----------------------------------|--------|--------|--------|-----------|--------");
const cellResults = {};
for (const [label, filter, since] of cells) {
  const res = backtestBand(filter, since);
  for (const band of ["5~10%", "10~15%"]) {
    const rows = res[band];
    const items = new Set(rows.map((r) => r.item)).size;
    const vals = rows.map((r) => r.excess);
    cellResults[`${label}|${band}`] = median(vals);
    console.log(
      `${label.padEnd(33)} | ${band.padEnd(6)} | ${String(rows.length).padStart(6)} | ${String(items).padStart(6)} | ` +
        `${fmt(median(vals))} | ${fmt(pctNeg(vals))}`
    );
  }
}
console.log("");
console.log("**Q2-口径 读数**：");
console.log(`  · 影子实测 5~10% = ${fmt(s510?.median ?? NaN)}，10~15% = ${fmt(s1015?.median ?? NaN)}`);
console.log(`  · 格子④（同总体 + 同区间的回测）= ${fmt(cellResults["④ 只影子饰品 × 只 8 月|5~10%"])} / ${fmt(cellResults["④ 只影子饰品 × 只 8 月|10~15%"])}`);
console.log("  · ④ 接近影子实测 ⇒ **差异是口径（总体+区间）不是市场**，那 −6.37% 就不能跟");
console.log("    已发布的 −2.75% 并排比较，得先对齐。");
console.log("  · ④ 仍接近 ①（−2.8% 上下）⇒ 总体和区间解释不了，残差要去查定义或别的。");
console.log("");
console.log("  分解（各贡献多少 pp）：");
const c1 = cellResults["① 全市场 × 全区间（= 已发布的回测）|5~10%"];
const c2 = cellResults["② 全市场 × 只 8 月|5~10%"];
const c3 = cellResults["③ 只影子饰品 × 全区间|5~10%"];
const c4 = cellResults["④ 只影子饰品 × 只 8 月|5~10%"];
console.log(`    只换区间（①→②）：${((c2 - c1) * 100).toFixed(2)}pp`);
console.log(`    只换总体（①→③）：${((c3 - c1) * 100).toFixed(2)}pp`);
console.log(`    两者都换（①→④）：${((c4 - c1) * 100).toFixed(2)}pp`);
console.log(`    影子 − ④（残差）：${(((s510?.median ?? NaN) - c4) * 100).toFixed(2)}pp ← 这一截才需要用"市场变了"或"定义不同"解释`);
console.log("");

// ============================================================================
// Q2-定义：生产存的 return_24h vs 回测口径重算
// ============================================================================
console.log("=== Q2（定义）：生产算的 24h 涨幅 vs 回测口径重算，逐条比 ===");
console.log("`shadow_sell_signals.return_24h` 是**生产当时算出来的**，这是一次真正的");
console.log("「生产 vs 回测」等价性验证（第四节 0.5 清单里 24h 涨幅正是没核对过的一项）。");
const diffs = [];
let cmpErr = 0;
for (const r of shadowRows) {
  const platform = r.platform;
  const series = seriesFor(r.item_name, platform);
  if (!series.length) {
    cmpErr += 1;
    continue;
  }
  const idx = new Map(series.map(([h], i) => [h, i]));
  const hour = Math.floor(Date.parse(r.decided_at) / HOUR_MS) * HOUR_MS;
  const i = idx.get(hour);
  if (i === undefined || i < 24) {
    cmpErr += 1;
    continue;
  }
  const prev = series[i - 24]?.[1];
  if (!prev || prev <= 0) {
    cmpErr += 1;
    continue;
  }
  const mine = (series[i][1] - prev) / prev;
  diffs.push({ item: r.item_name, at: r.decided_at, prod: r.return_24h, mine, d: mine - r.return_24h });
}
if (diffs.length) {
  const ad = diffs.map((x) => Math.abs(x.d)).sort((a, b) => a - b);
  const exact = diffs.filter((x) => Math.abs(x.d) < 1e-9).length;
  const within1pp = diffs.filter((x) => Math.abs(x.d) < 0.01).length;
  console.log(
    `可比对 ${diffs.length} 条（${cmpErr} 条取不到对应快照）：完全相同 ${exact}（${((100 * exact) / diffs.length).toFixed(1)}%）、` +
      `差 <1pp ${within1pp}（${((100 * within1pp) / diffs.length).toFixed(1)}%）`
  );
  console.log(`  |差| 中位数 ${(median(ad) * 100).toFixed(3)}pp、p95 ${(ad[Math.floor(ad.length * 0.95)] * 100).toFixed(3)}pp、最大 ${(ad[ad.length - 1] * 100).toFixed(3)}pp`);
  console.log("  差异最大的 5 条：");
  for (const x of [...diffs].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5)) {
    console.log(
      `    ${x.item.slice(0, 42).padEnd(42)} ${x.at.slice(0, 16)}  生产 ${(x.prod * 100).toFixed(2)}%  回测 ${(x.mine * 100).toFixed(2)}%  差 ${(x.d * 100).toFixed(2)}pp`
    );
  }
  console.log("");
  console.log("  **读法**：差异大 ⇒ 两边的「24h 涨幅」不是同一个量，那么「影子 5~15%」和");
  console.log("  「回测 5~15%」装的根本不是同一批样本，比较本身就不成立。");
} else {
  console.log("一条都比不了，定义检查没做成。");
}
console.log("");

// ============================================================================
// Q3：证据强度落在哪里
// ============================================================================
console.log("=== Q3：我们盯着的和数据给的是不是同一处 ===");
const byAction = db
  .prepare(
    `SELECT action, COUNT(*) n, COUNT(DISTINCT item_name) items
     FROM shadow_sell_signals WHERE rule_version='v2' GROUP BY action`
  )
  .all();
console.log("影子表按动作：");
for (const r of byAction) console.log(`  ${String(r.action).padEnd(12)} ${String(r.n).padStart(5)} 条 / ${r.items} 个饰品`);
console.log("");
console.log(`对照：本次归因的 HOLD 5~15% 段是 **${holdSamples.length} 条可评估 / ${shadowItems.size} 个饰品**。`);
console.log("**v2 真正在验的是 SELL 和 SELL_STRONG 两档，而它们的可评估样本一直是个位数。**");
console.log("也就是说：**证据强度最高的一段，恰好是规则明确选择不表态的那一段。**");
console.log("这本身要写进报告——不是因为它改变了什么，而是因为它说明我们的注意力");
console.log("和数据的信息量长期不在同一处。");
console.log("");
console.log("=== 这份输出不能证明什么 ===");
console.log("· 它只做归因，**不改任何阈值**（预先声明）。");
console.log(`· 即使归因全部扛住，−6.37% 对 6.7% 是**贴近不是越过**，按我们自己的判据「贴近就是不够」；`);
console.log("  5~10% 那档更明显不够。所以最好的结果也只是把这一段从「明确不触发」改成");
console.log("  「待样本、继续观察」，**不是**新增一个卖出档。");
console.log("· 真要往前走，下一步是**新开一档影子并行**跟现有档位并列记录、不参与真实平仓，");
console.log("  攒到自己的样本门槛再谈——v2 当初立的规矩就是这样，而这次的诱惑恰恰是「数据够好可以直接上」。");
