// 模拟盘平仓成绩单。用法：node scripts/report-paper-trades.mjs（云端容器里跑）
//
// **这个脚本刻意在有平仓数据之前就写好。** 2026-07-30 那次模拟盘归因就是等到数据摆在
// 面前才现搭口径的，结果差点把大盘普跌当成策略失败（表面 -3.15%，放进对照基准后超额
// 约等于 0）。带着已经看到的数字去定口径，会不自觉地被结果牵着走。
//
// ---- 五条口径，一条都不能省 ----
// ① **报超额不报绝对收益**。每笔的收益要减掉同一持有窗口里全市场的中位数收益。
//    口径跟 scripts/build-sell-rule-baseline.mjs 一致（当天全部饰品的中位数收益），
//    这样两边的数字可以直接对照。不扣基准的话，在普跌行情里卖什么都"卖对了"。
// ② **按饰品去重，并报出集中度**。2026-07-30 那批 153 笔里 79 笔（52%）开在同一天，
//    统计上更接近 n=2 而不是 n=153。所以除了笔数，还要报不同饰品数、不同开仓日数、
//    最大单日开仓占比——让"独立赌注数"这件事摆在明面上。
// ③ **stale_data 整批剔除**。那类成交价是"最后一条已知快照价"不是"决策当时的价"，
//    跟正常平仓不可比（lib/paper-trading.ts 里也是这么写的）。剔除后单独报一行数量。
// ④ **反事实对照**：每笔 v2 平掉的仓位，同时算出"如果一直持到第 30 天会是多少"。
//    这是评估"提前卖"值不值的唯一办法，而且这个反事实可以事后从 price_snapshots 直接
//    算出来，不需要真的留一组不平仓的对照组。**算不出来的要单独计数标出来，不许静默丢弃**
//    （饰品移出观察池就不再同步，滑出 21 天读取窗口后价格就取不到了）。
// ⑤ **样本不够时不下结论**。回测里 15~20% 档的为负占比也才 61%，几十条样本的随机波动
//    完全能盖过这个幅度。所以每一组都打印中位数和分位数，而不是只给一个平均值。
import Database from "better-sqlite3";
import { assertBaselineTable, loadBaseline } from "./market-baseline-store.mjs";

// 第一个参数可以指定别的库文件。生产上不用传（默认就是容器里的路径），它存在是为了能拿
// 构造好的样本库先把这个脚本跑通——在真实平仓出现之前，整个主体是没被执行过的代码，
// 等 8-21 数据到了才发现写错就晚了。
const db = new Database(process.argv[2] ?? "data/db.sqlite", { readonly: true });
const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
const HOLD_HORIZON_DAYS = 30; // 反事实对照的持有期，跟 lib/paper-trading.ts 的 MAX_HOLD_MS 一致
const SELL_FEE = 0.01; // C5 普通用户费率，跟 lib/fees.ts 一致
// 取价格时允许的容差：同步偶尔会错过整点，卡死在精确时刻会白丢样本
const PRICE_TOLERANCE_MS = 6 * HOUR_MS;

// ---------- 小工具 ----------
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const quantile = (a, q) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const pct = (v) => (Number.isNaN(v) ? "    -   " : (v * 100).toFixed(2).padStart(7) + "%");
const dayKey = (iso) => new Date(iso).toISOString().slice(0, 10);

// 表格左列混着中英文，padEnd 数的是字符数不是显示宽度，中日韩字符占两格——
// 直接用 padEnd 会让每张表的竖线参差不齐。这里按显示宽度补空格。
const displayWidth = (s) =>
  [...s].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
function padDisplay(s, width) {
  const text = String(s);
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

// ---------- 数据读取 ----------
const priceAt = db.prepare(
  `SELECT price FROM price_snapshots
   WHERE item_name = ? AND platform = ? AND price > 0
     AND captured_at >= ? AND captured_at < ?
   ORDER BY captured_at ASC LIMIT 1`
);

/** 某饰品在某时刻（±容差）的价格。取不到返回 null——调用方必须显式处理，不许当 0。 */
function priceNear(itemName, platform, atMs) {
  const row = priceAt.get(
    itemName,
    platform,
    new Date(atMs).toISOString(),
    new Date(atMs + PRICE_TOLERANCE_MS).toISOString()
  );
  return row ? row.price : null;
}

// 大盘基准改读物化表（迁移 023 + scripts/build-market-baseline.mjs）。原来这里是现场
// 按开仓日扫窗口算，即便按窗口记忆化，生产库上整份报告仍要 22 分钟——而基准只跟
// (日期, 窗口) 有关、跟脚本无关，三个评估脚本共用一份即可。
//
// **这个脚本保持只读**：需要的 (日期, 窗口) 缺了就记一笔、最后统一提示去跑 builder，
// 不在报告里顺手写库——报告写缓存的话，同一份报告不同时间跑会读到不同缓存，
// 出了问题分不清是数据变了还是缓存脏了。
assertBaselineTable(db);
const baselineCache = new Map(); // horizon -> Map(dayMs -> {median})
const missingBaselineKeys = new Set(); // `${day}|${horizon}`，最后打印成一条 builder 命令

function marketReturn(fromMs, horizonDays) {
  const day = Math.floor(fromMs / DAY_MS) * DAY_MS;
  if (!baselineCache.has(horizonDays)) baselineCache.set(horizonDays, loadBaseline(db, horizonDays));
  const hit = baselineCache.get(horizonDays).get(day);
  if (!hit) {
    missingBaselineKeys.add(`${new Date(day).toISOString().slice(0, 10)}|${horizonDays}`);
    return null;
  }
  return hit.median;
}

// ---------- 组装每笔平仓的评估记录 ----------
const closed = db
  .prepare("SELECT * FROM paper_trades WHERE status = 'closed' ORDER BY closed_at ASC")
  .all();
const open = db.prepare("SELECT COUNT(*) n FROM paper_trades WHERE status = 'open'").get().n;

console.log(`模拟盘：已平仓 ${closed.length} 笔，仍持仓 ${open} 笔`);
if (!closed.length) {
  console.log("");
  console.log("还没有平仓记录，没什么可评估的。卖出规则 v2 要 24h 涨幅 ≥15% 才触发，回测里");
  console.log("这三档合计只占全部饰品-小时的 2.7%——**没到就是没到，这是条件没满足不是 bug**。");
  console.log("核对办法：看当前有没有饰品的 24h 涨幅达到 15%。最老的仓位满 30 天会走超时强平。");
  process.exit(0);
}

const staleTrades = closed.filter((t) => t.close_reason === "stale_data");
const usable = closed.filter((t) => t.close_reason !== "stale_data");
console.log(
  `其中 stale_data ${staleTrades.length} 笔已整批剔除（成交价不是"决策当时"的价，跟正常平仓不可比），` +
    `实际参与评估 ${usable.length} 笔`
);

const records = [];
let missingBaseline = 0;
let missingCounterfactual = 0;

for (const t of usable) {
  const openedMs = Date.parse(t.opened_at);
  const closedMs = Date.parse(t.closed_at);
  const heldDays = (closedMs - openedMs) / DAY_MS;

  // 实际收益：按净到手价（已扣 1% 卖出手续费）对开仓价
  const actual = (t.sell_net_price - t.buy_price) / t.buy_price;

  // 大盘基准取同一持有窗口：开仓当天起、持有同样天数的全市场中位数收益。
  // 只有这样"超额"才是"同期同样拿着现金买别的会怎样"。
  const base = marketReturn(openedMs, Math.max(1, Math.round(heldDays)));
  if (base === null) missingBaseline += 1;

  // 反事实：一直持到第 30 天。同样扣一次卖出手续费，跟实际收益可比。
  const price30 = priceNear(t.item_name, t.platform, openedMs + HOLD_HORIZON_DAYS * DAY_MS);
  let hold30 = null;
  if (price30 !== null) {
    hold30 = (price30 * (1 - SELL_FEE) - t.buy_price) / t.buy_price;
  } else {
    missingCounterfactual += 1;
  }

  records.push({
    trade: t,
    heldDays,
    actual,
    excess: base === null ? null : actual - base,
    hold30,
    // 提前卖比持到 30 天多赚多少（正数 = 卖对了）
    earlySellGain: hold30 === null ? null : actual - hold30,
  });
}

// ---------- ② 集中度：先说清楚这里到底有多少个独立赌注 ----------
console.log("");
console.log("=== 集中度（先看这个，再看收益）===");
const byOpenDay = new Map();
for (const r of records) {
  const d = dayKey(r.trade.opened_at);
  byOpenDay.set(d, (byOpenDay.get(d) ?? 0) + 1);
}
const distinctItems = new Set(records.map((r) => r.trade.item_name)).size;
const maxDay = [...byOpenDay.entries()].sort((a, b) => b[1] - a[1])[0];
console.log(`平仓笔数 ${records.length} | 不同饰品 ${distinctItems} 个 | 不同开仓日 ${byOpenDay.size} 天`);
if (maxDay) {
  console.log(
    `最集中的一天：${maxDay[0]} 开了 ${maxDay[1]} 笔，占 ${((100 * maxDay[1]) / records.length).toFixed(1)}%`
  );
}
console.log("开仓日分布：" + [...byOpenDay.entries()].sort().map(([d, n]) => `${d}×${n}`).join("  "));
console.log(
  "读法：同一天开的仓位同涨同跌，统计上不是独立样本。上面那个'最集中的一天'占比越高，"
);
console.log("     有效样本量就越接近'开仓日数'而不是'笔数'——7-30 那次 52% 开在同一天，实质 n≈2。");

// ---------- ①⑤ 超额收益 ----------
function describe(label, arr) {
  const clean = arr.filter((v) => v !== null && !Number.isNaN(v));
  if (!clean.length) {
    console.log(`${padDisplay(label, 22)} |     0 |    -    |    -    |    -    |    -    |   -`);
    return;
  }
  const neg = clean.filter((v) => v < 0).length;
  console.log(
    `${padDisplay(label, 22)} | ${String(clean.length).padStart(5)} | ${pct(median(clean))} | ` +
      `${pct(quantile(clean, 0.25))} | ${pct(quantile(clean, 0.75))} | ` +
      `${pct(neg / clean.length)} | ${clean.length < 30 ? "样本不足" : ""}`
  );
}

console.log("");
console.log(`=== 收益（超额 = 实际收益 − 同期同持有天数的全市场中位数）===`);
if (missingBaseline) {
  console.log(`⚠️  ${missingBaseline} 笔取不到大盘基准，已从超额统计中剔除`);
  const horizons = [...new Set([...missingBaselineKeys].map((k) => k.split("|")[1]))].sort(
    (a, b) => a - b
  );
  console.log(`   缺的是这些窗口：${horizons.join(", ")} 天。补一下再看：`);
  console.log(`   node scripts/build-market-baseline.mjs ${horizons.join(" ")}`);
}
console.log("口径                   | 样本数 | 中位数  |   p25   |   p75   | 为负占比 | 备注");
console.log("-----------------------|-------|---------|---------|---------|---------|------");
describe("绝对收益（会骗人）", records.map((r) => r.actual));
describe("超额收益（看这个）", records.map((r) => r.excess));

// ---------- ⑤ 分组：close_reason × 档位 ----------
function groupBy(keyFn) {
  const m = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function printGroups(title, m, note) {
  console.log("");
  console.log(`=== 按${title}分组（超额收益）===`);
  if (note) console.log(note);
  console.log("分组                   | 样本数 | 中位数  |   p25   |   p75   | 为负占比 | 备注");
  console.log("-----------------------|-------|---------|---------|---------|---------|------");
  for (const [k, arr] of [...m.entries()].sort((a, b) => b[1].length - a[1].length)) {
    describe(String(k), arr.map((r) => r.excess));
  }
}

printGroups(
  "平仓原因",
  groupBy((r) => r.trade.close_reason),
  "sell_rule_v2_strong = 24h 涨幅 ≥30%（回测超额中位 -18.69%）；sell_rule_v2 = 15~30%（-4.35%~-5.89%）；\n" +
    "timeout = 等满 30 天也没等到卖出信号。**两个卖出档必须分开看，回测里差了一个数量级。**"
);
printGroups(
  "开仓日（cohort）",
  groupBy((r) => dayKey(r.trade.opened_at)),
  "结论如果只在某一天的 cohort 上成立，那就是那天的行情不是规则的功劳。"
);
printGroups(
  "入场 score",
  groupBy((r) => `score ${r.trade.buy_score}`),
  "30 = 只有 RSI 超卖这一个信号；40 以上 = 多信号叠加。ENTRY_MIN_SCORE 要不要从 30 提到 40，看这两行的差距。"
);

console.log("");
console.log("=== 按饰品（只列出现 ≥2 笔的）===");
const byItem = groupBy((r) => r.trade.item_name);
const repeated = [...byItem.entries()].filter(([, arr]) => arr.length >= 2);
if (!repeated.length) {
  console.log("没有任何饰品出现 2 笔以上——也就是说笔数和饰品数基本一一对应，没有重复计数问题。");
} else {
  console.log("饰品                   | 笔数 | 超额中位数");
  for (const [item, arr] of repeated.sort((a, b) => b[1].length - a[1].length)) {
    const vals = arr.map((r) => r.excess).filter((v) => v !== null);
    console.log(`${padDisplay(item.slice(0, 22), 22)} | ${String(arr.length).padStart(4)} | ${pct(median(vals))}`);
  }
}

// ---------- ④ 反事实：提前卖 vs 持到第 30 天 ----------
console.log("");
console.log("=== 反事实对照：v2 提前卖，比一直持到第 30 天好多少 ===");
console.log("（正数 = 提前卖对了。这个反事实直接从 price_snapshots 算，不需要留一组不平仓的对照组）");
if (missingCounterfactual) {
  console.log(
    `⚠️  ${missingCounterfactual} 笔算不出反事实（第 30 天那个时点没有价格快照——饰品被移出观察池后` +
      `就不再同步，滑出 21 天读取窗口价格就取不到了）。**这些是显式剔除不是静默丢弃**，` +
      `占比 ${((100 * missingCounterfactual) / records.length).toFixed(1)}%；占比高的话下面的数字要打折看。`
  );
}
const earlySold = records.filter((r) => r.trade.close_reason?.startsWith("sell_rule_v2"));
console.log("");
console.log("口径                   | 样本数 | 中位数  |   p25   |   p75   | 为负占比 | 备注");
console.log("-----------------------|-------|---------|---------|---------|---------|------");
describe("提前卖 − 持到30天", earlySold.map((r) => r.earlySellGain));
describe("  其中强档(≥30%)", earlySold.filter((r) => r.trade.close_reason === "sell_rule_v2_strong").map((r) => r.earlySellGain));
describe("  其中普通档(15~30%)", earlySold.filter((r) => r.trade.close_reason === "sell_rule_v2").map((r) => r.earlySellGain));

// ---------- 收尾：把"能不能下结论"这件事写死 ----------
const evaluable = records.filter((r) => r.excess !== null).length;
console.log("");
console.log("=== 能不能下结论 ===");
console.log(`可评估样本 ${evaluable} 笔 / 不同饰品 ${distinctItems} 个 / 不同开仓日 ${byOpenDay.size} 天`);
if (evaluable < 30 || byOpenDay.size < 5) {
  console.log("");
  console.log("**样本不足，不要下结论。** 判据：可评估样本 <30 笔，或开仓日 <5 天（同日开仓不是独立样本）。");
  console.log("回测里 15~20% 档的为负占比也才 61%，几十条样本的随机波动完全能盖过这个幅度。");
  console.log("现在能说的只有'触发了几次、方向大致如何'，不能说规则准不准。");
} else {
  console.log("");
  console.log("样本量过了最低门槛，可以开始看方向了。但要替换/调整规则，还要同时满足：");
  console.log("  · 两个卖出档的超额中位数都为负（说明卖在了相对高点），且强档明显比普通档更负；");
  console.log("  · 反事实那节的'提前卖 − 持到30天'中位数为正（说明早卖确实避开了回落）；");
  console.log("  · 结论在多个开仓日 cohort 上一致，不是靠某一天的行情撑起来的。");
}
console.log("");
console.log("对照：scripts/report-shadow-sell-signals.mjs 出的是影子表那边的触发次数和命中率。");
console.log("     两边用的是同一次 v2 判定（lib/paper-trading.ts 的 evaluateSellDecision），数字应该对得上。");
