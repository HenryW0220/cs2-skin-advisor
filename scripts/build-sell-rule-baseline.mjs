// 从真实数据反推卖出阈值。用法：node scripts/build-sell-rule-baseline.mjs（云端容器里跑）
//
// 为什么要有这个脚本：现在规则引擎的卖出侧（`lib/rules/evaluate.ts`）权重是当初凭经验拍的
// （RSI 超买 -30 / 趋势走弱 -25 / 成交量异动 -15），2026-08-03 查出来它在结构上**永远
// 触发不了**——SELL 要 score ≤ -40，而全库最负的 score 是 -30，能补足差额的成交量项
// 又是死信号（喂的是在售量这个存量，比值中位数恰好 1.000）。详见 HANDOFF 踩坑 43。
//
// 重新设计卖出规则时的口径（项目所有者定的）：
//   1. 只用**已被回测验证过**的信号做核心权重，没有数据支撑的项不进规则、或只给极低权重
//      并明确标注"未验证"；
//   2. 阈值必须能从回测数据反推出来，写清依据；
//   3. 新规则先在模拟盘和现有规则**并行**跑至少一轮，给出触发次数和假信号率再谈替换。
// 这个脚本负责第 2 条。
//
// 已验证的两个信号：**追涨风险**（REPORT-t7-actionable-labels.md：24h 涨幅 >15% 时未来 7 天
// 平均 -10.74%、70.8% 概率为负）是卖出方向的证据；**洗盘回撤 drawdown48h**
// （REPORT-manipulation-playbook-stages.md + 两版预测基线里的最大正权重特征）是"深回撤之后
// 倾向反弹"、也就是**不该卖**的方向，所以要看两者叠加时会不会互相抵消。
//
// ---- 统计口径，三条都是 2026-08-03 当天踩出来的（HANDOFF 踩坑 44）----
// ① **不看均值，看中位数**：第一版用均值，">30% 档"出现"未来3天 +39%、未来7天 -14%"这种
//    自相矛盾的结果，洗盘表里甚至有 +373%——皮肤价格是重尾分布，几个从几毛涨到几块的
//    低价品就能主导均值。均值在这里没有意义，只保留中位数和"为负占比"。
// ② **要扣掉大盘**：这段时间整个市场在跌（连"24h 下跌"档的未来 7 天中位数都是负的），
//    不设对照基准会把 beta 当成信号。这里的基准是"当天全部饰品未来 7 天收益的中位数"，
//    报的是**超额**收益。
// ③ **要按饰品检验**：池化样本高度自相关，几十万条样本的有效样本量远小于名义值。
//    最后一节对"该档位的超额收益中位数是否为负"按饰品做符号检验。
//
// ---- ⚠️ 为什么这个脚本报**纯超额**是对的，而买入侧不是（2026-08-15 补，必读）----
// 买入侧那份分档表（build-t7-entry-baseline.mjs）的录取判据是"**绝对**收益中位数 ≥ 成本线
// 且超额 > 0"，比这里严。**这不是两个脚本口径不一致，是标的不同**：
//
//   · **卖出侧决定的是"换不换手"**。两个选项（现在卖 / 继续持有）**持有的是同一份资产**，
//     大盘涨跌对双方影响一样，在差额上抵消——所以"扣掉当天全市场中位数"的超额口径
//     本来就是对的比较基准。**v2 的全部阈值按纯超额反推是对的，不受买入侧那条新判据影响。**
//   · **买入侧决定的是"要不要动用现金"**。对照物是**现金**，不是市场。大盘跌 10% 而某饰品
//     只跌 2%，超额 +8% 而现金 −2%——**拿不出钱付手续费**。所以买入侧必须同时看绝对值。
//
// **这条以后每次有人做新分档都会踩，而且踩了不报错**：只按超额判买入侧，会把一堆
// "跌得比大盘少"的档位误读成买点（2026-08-15 实测：买入侧十几个档位是"超额为正、绝对为零"）。
// 判之前先问一句：**这个决策的对照物是同一份资产，还是现金？**
//
// 其他口径：卖出侧不受 T+7 影响（锁定只锁买入后 7 天），所以不加锁定期约束；
// 比的是"此刻卖"vs"继续持有 N 天"的毛收益，两边都要扣一次手续费、差额上抵消。
// 按小时重采样，跟 lib/signals/resample.ts 同口径。
import Database from "better-sqlite3";
import { assertBaselineTable, baselineProvenance, loadBaseline } from "./market-baseline-store.mjs";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

// ---- --since：把样本限制在某个日期之后，用来做 régime 复核 ----
// 加这个参数的唯一理由（2026-08-14）：`report-regime-boundaries.mjs` 查出 2026-04 那批台阶
// 和 5~6 月平台数在 1↔5 之间反复跳，**至今没有对应的已知配置变更**。平台数变化直接改变
// 多平台取价的构成，也就直接改变这里算的每一个收益和超额——而这张表跨越了那一段
// （714 饰品 / 99 天），v2 的**全部**阈值从它反推。
//
// **不能因为它是我们喜欢的结论就给它豁免。** 但也不能借机重跑一切——那就是在搜。
// 所以做成一次**有界的、预先声明的方向性复核**，声明写在这里（不是事后补的）：
//   · 只问一个问题：把样本限制在 2026-07-01 之后，**>30% 那个台阶在方向上还在不在**。
//   · **这是一次检验，不是一组。** 幅度和 p 值都不看——样本会大幅缩水，看了就是在搜。
//   · 台阶还在 → HANDOFF 注明"已用后 régime 数据做过方向性复核"，继续用，**不改阈值**。
//   · 台阶没了 → v2 失去地基，接进 /positions 的讨论全部暂停，先去查 régime 是什么。
const args = parseScriptArgs({
  name: "build-sell-rule-baseline",
  usage: "node scripts/build-sell-rule-baseline.mjs [库文件] [--since YYYY-MM-DD]",
  values: { "--since": { parse: String, default: "", label: "只用这个日期之后的样本" } },
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const sinceDay = args.values["--since"];
const sinceMs = sinceDay ? Date.parse(`${sinceDay}T00:00:00.000Z`) : null;
if (sinceDay && !Number.isFinite(sinceMs)) {
  console.error(`✗ --since 的值 "${sinceDay}" 不是合法日期（要 YYYY-MM-DD）`);
  process.exit(1);
}
const db = new Database(resolveDbPath(args.dbPath), { readonly: true });
const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const HORIZON_DAYS = 7; // 主口径。REPORT-t7 用的也是 7 天，可比
const WASHOUT_DRAWDOWN = 0.15; // 跟 lib/signals/washout.ts 一致

function referencePlatform(itemName) {
  const rows = db
    .prepare(
      `SELECT platform, COUNT(*) n FROM price_snapshots
       WHERE item_name = ? AND price > 0 GROUP BY platform ORDER BY n DESC`
    )
    .all(itemName);
  for (const p of PLATFORM_PRIORITY) {
    const hit = rows.find((r) => r.platform === p);
    if (hit && hit.n >= 200) return p;
  }
  return rows[0]?.n >= 200 ? rows[0].platform : null;
}

function hourlyPrices(itemName, platform) {
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

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const pctNeg = (a) => (a.length ? a.filter((v) => v < 0).length / a.length : NaN);
const fmt = (v) => (Number.isNaN(v) ? "   -   " : (v * 100).toFixed(2).padStart(6) + "%");

// 涨幅分档。边界特意跨过 15%（REPORT-t7 用的阈值），看它两侧是不是真有台阶
const BANDS = [
  ["跌", -Infinity, 0],
  ["0~5%", 0, 0.05],
  ["5~10%", 0.05, 0.1],
  ["10~15%", 0.1, 0.15],
  ["15~20%", 0.15, 0.2],
  ["20~30%", 0.2, 0.3],
  [">30%", 0.3, Infinity],
];
const bandOf = (r) => BANDS.find(([, lo, hi]) => r >= lo && r < hi)?.[0] ?? null;

// ---------- 第一遍：算每个 (饰品,小时) 的前瞻收益，并按天汇总出大盘基准 ----------
const items = db.prepare("SELECT DISTINCT item_name FROM price_snapshots").all().map((r) => r.item_name);
const perItemSamples = new Map(); // item -> [{day, band, fwd, inWashout}]

let itemsUsed = 0;
for (const item of items) {
  const platform = referencePlatform(item);
  if (!platform) continue;
  const series = hourlyPrices(item, platform);
  if (series.length < 24 * (HORIZON_DAYS + 14)) continue;
  itemsUsed += 1;

  const hourIndex = new Map(series.map(([h], i) => [h, i]));
  const samples = [];
  for (let i = 48; i < series.length; i++) {
    const [ts, price] = series[i];
    const prev24 = series[i - 24]?.[1];
    if (!prev24 || prev24 <= 0) continue;
    const band = bandOf((price - prev24) / prev24);
    if (!band) continue;

    const futureIdx = hourIndex.get(ts + HORIZON_DAYS * DAY_MS);
    if (futureIdx === undefined) continue;
    const fwd = (series[futureIdx][1] - price) / price;

    let peak = 0;
    for (let k = Math.max(0, i - 48); k <= i; k++) peak = Math.max(peak, series[k][1]);
    const inWashout = peak > 0 && (peak - price) / peak > WASHOUT_DRAWDOWN;

    const day = Math.floor(ts / DAY_MS) * DAY_MS;
    // régime 复核：只保留边界之后的样本（见文件上方 --since 那段预先声明）
    if (sinceMs !== null && ts < sinceMs) continue;
    samples.push({ day, band, fwd, inWashout });
  }
  if (samples.length) perItemSamples.set(item, samples);
}

// 大盘基准改读物化表（迁移 023 + scripts/build-market-baseline.mjs）。
// 口径没变——物化表用的就是这里原来那套（按饰品取参考平台、按小时重采样、当天所有
// 小时样本取中位数，历史长度门槛同样是 24×(窗口+14) 小时），只是算一次存起来，
// 另外两个评估脚本共用同一份，不必各算各的。
assertBaselineTable(db);
const baselineRows = loadBaseline(db, HORIZON_DAYS);
if (baselineRows.size === 0) {
  console.log("market_baseline_daily 里还没有基准，先跑：node scripts/build-market-baseline.mjs");
  process.exit(0);
}
// v2 的全部阈值就是从这张表反推的，所以基准的口径版本必须跟着这份输出一起留下来（迁移 024）
console.log(baselineProvenance(db));
console.log("");
const marketByDay = new Map([...baselineRows.entries()].map(([day, v]) => [day, v.median]));

// ---------- 第二遍：按档位汇总超额收益 ----------
const agg = new Map(); // band -> {all:[], washout:[], noWashout:[]}
for (const [label] of BANDS) agg.set(label, { all: [], washout: [], noWashout: [] });

for (const [, samples] of perItemSamples) {
  for (const s of samples) {
    const base = marketByDay.get(s.day);
    if (base === undefined || Number.isNaN(base)) continue;
    const excess = s.fwd - base;
    const bucket = agg.get(s.band);
    bucket.all.push(excess);
    (s.inWashout ? bucket.washout : bucket.noWashout).push(excess);
  }
}

console.log(`参与统计的饰品：${itemsUsed} 个；大盘基准覆盖 ${marketByDay.size} 天`);
if (sinceDay) {
  console.log(
    `⚠️ **régime 复核模式**：样本已限制在 ${sinceDay} 之后。这是一次预先声明的方向性检验，` +
      `只看 >30% 那个台阶还在不在——**幅度和 p 值不作数**（样本大幅缩水，看了就是在搜）。`
  );
}
console.log("");
console.log(`口径：超额 = 该样本未来 ${HORIZON_DAYS} 天收益 − 当天全市场中位数。只看中位数，均值被重尾主导没有意义。`);
console.log("");
// 洗盘那两列**必须带各自的样本数**：中位数背后是 3 个样本还是 3000 个样本，
// 读起来完全是两回事。v2 的"深回撤且低涨幅时明确不卖"就是从洗盘那一列反推的，
// 而它在实盘上线 40 天一次都没触发过（HANDOFF ⑭）——要判断那是"罕见但合理"还是
// "实盘判定跟回测反推不一致"，靠的就是这里的洗盘样本占比。
console.log("24h涨幅档  |  样本数 | 超额中位数 | 超额为负占比 | 非洗盘时超额(n) | 洗盘时超额(n) | 洗盘占比");
console.log("-----------|--------|-----------|-------------|----------------|--------------|--------");
for (const [label] of BANDS) {
  const b = agg.get(label);
  const share = b.all.length ? `${((100 * b.washout.length) / b.all.length).toFixed(2)}%` : "-";
  console.log(
    `${label.padEnd(10)} | ${String(b.all.length).padStart(6)} | ${fmt(median(b.all))} | ` +
      `${fmt(pctNeg(b.all))} | ${fmt(median(b.noWashout))}(${String(b.noWashout.length).padStart(6)}) | ` +
      `${fmt(median(b.washout))}(${String(b.washout.length).padStart(5)}) | ${share.padStart(7)}`
  );
}

// ---------- 第三节：按饰品符号检验 ----------
// 池化数字再漂亮，也要看有多少个**饰品**各自也呈现同一方向。特征无效时应该是抛硬币。
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

console.log("");
console.log("=== 按饰品检验：该档位的超额收益中位数是否为负（判据看这里）===");
console.log("24h涨幅档  | 有该档样本的饰品数 | 超额中位数为负的 | 各饰品中位数的中位数 | 符号检验 p");
console.log("-----------|------------------|----------------|--------------------|----------");
for (const [label] of BANDS) {
  const perItemMedians = [];
  for (const [, samples] of perItemSamples) {
    const vals = samples
      .filter((s) => s.band === label && marketByDay.has(s.day))
      .map((s) => s.fwd - marketByDay.get(s.day))
      .filter((v) => !Number.isNaN(v));
    if (vals.length < 12) continue; // 至少半天的样本，太少的饰品不算
    perItemMedians.push(median(vals));
  }
  const neg = perItemMedians.filter((v) => v < 0).length;
  console.log(
    `${label.padEnd(10)} | ${String(perItemMedians.length).padStart(18)} | ${String(neg).padStart(14)} | ` +
      `${fmt(median(perItemMedians)).padStart(19)} | ${signTestP(neg, perItemMedians.length).toFixed(4)}`
  );
}

console.log("");
console.log("读法：某档位要当卖出触发条件，需要同时满足——超额中位数明显为负、为负占比过半、");
console.log("     且按饰品检验的符号检验 p 足够小（说明不是靠少数几个饰品拉出来的）。");
console.log("     \"洗盘时超额\"和\"非洗盘时超额\"差别大的档位，规则里要写成组合条件而不是单条。");
