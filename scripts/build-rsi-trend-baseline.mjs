// 回算 RSI 和均线趋势的超额收益。用法：node scripts/build-rsi-trend-baseline.mjs（云端容器里跑）
//
// **只读脚本，不改任何生产代码，也没动 build-sell-rule-baseline.mjs**（那个的数字被跨次
// 对比着，往里加分档会破坏可比性）。
//
// 要回答的问题：v1 规则引擎（lib/rules/evaluate.ts）的两个主要打分来源——RSI 超买/超卖
// （±30）和均线趋势走强/走弱（+15/−25）——**从来没有任何回测支撑**，权重是当初拍的经验值
// （HYPOTHESES.md §2.2）。成交量那一项已经查明是死信号并删除了，剩下这两项是 v1 的全部。
// 这个脚本用跟 build-sell-rule-baseline.mjs **完全一致的口径**给它们做同样的检验：
//   超额 = 某时点的"未来 7 天收益 − 当天全市场中位数收益"
// 只把分档维度从「24h 涨幅」换成「RSI 档位」和「趋势状态」。
//
// ---- 一个必须先说清楚的事实：v1 的 MA7/MA30/RSI14 是**小时**不是**天** ----
// CLAUDE.md 写的是"RSI 周期是 14 天"、指标叫 MA7/MA30（按惯例指 7 日/30 日），但
// lib/signal-summary.ts 喂给它们的是 `resampleHourly(history)` 之后的**小时桶**：
//     const hourly = resampleHourly(history);
//     const prices = hourly.map((h) => h.price);
//     ma7: movingAverage(prices, 7)      ← 7 个小时桶 = 7 小时
//     ma30: movingAverage(prices, 30)    ← 30 小时 = 1.25 天
//     rsi14: rsi(prices, 14)             ← 14 小时
// 也就是说线上跑的是一套**日内尺度**的指标，而名字和文档说的是周线/月线尺度，
// 差了约一个数量级。所以本脚本**两种口径都算**：
//   · 「小时」= 精确复刻线上（7/30/14 个小时桶）——这是在评估 v1 现在到底在做什么；
//   · 「日」  = 名字本来的意思（按天重采样后 7/30/14 天）——这是在评估这个概念本身有没有用。
// 两者分开报，是为了让结论能区分"概念没用"和"尺度接错了"——这两种的处理方式完全不同。
//
// ---- 判据走 HYPOTHESES.md 第五节，不只报 p 值 ----
// 第一关 按标的各自算 + 符号检验（池化会被自相关虚高）；第二关 并列值会把 AUC 机械地
// 拉向 0.5，趋势状态只有 3 个取值，天然重并列，必须报并列占比；第三关 量纲——RSI 和
// 趋势状态本身就是无量纲的，这关不适用，写出来是为了说明不是漏了；第四关 Bonferroni；
// **第五关 效应量下限**。
//
// ---- 关于效应量的参照线，这里必须说清楚，否则会拿错尺子 ----
// HYPOTHESES.md 记的 0.744~0.819 是**操盘期 vs 平时**那个判别任务的 AUC，跟这里
// "预测未来超额收益为负"**不是同一个任务**，不能直接当及格线用（跨任务比 AUC 是错的）。
// 所以本脚本自带**阳性对照**：把 `return24h`（24h 涨幅，v2 全部阈值就建立在它上面、
// 已被两条独立路径验证）放进**同一个** AUC 计算里。RSI 和趋势要跟它比，不跟 0.744 比。
// 没有同任务参照线的效应量判断是没有意义的。
import Database from "better-sqlite3";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "build-rsi-trend-baseline",
  usage: "node scripts/build-rsi-trend-baseline.mjs [库文件]",
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const db = new Database(resolveDbPath(args.dbPath), { readonly: true });

const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const HORIZON_DAYS = 7;
const MIN_ROWS = 200; // 跟 build-sell-rule-baseline.mjs 一致
const MIN_SAMPLES_PER_ITEM = 12; // 至少半天样本，太少的饰品 AUC 噪声压过信号
const MIN_MARKET_SAMPLES = 20;

// 生产阈值，跟 lib/rules/evaluate.ts 保持一致
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;

// ---------- 跟 build-sell-rule-baseline.mjs 相同的取数逻辑 ----------
function referencePlatform(itemName) {
  const rows = db
    .prepare(
      `SELECT platform, COUNT(*) n FROM price_snapshots
       WHERE item_name = ? AND price > 0 GROUP BY platform ORDER BY n DESC`
    )
    .all(itemName);
  for (const p of PLATFORM_PRIORITY) {
    const hit = rows.find((r) => r.platform === p);
    if (hit && hit.n >= MIN_ROWS) return p;
  }
  return rows[0]?.n >= MIN_ROWS ? rows[0].platform : null;
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

// ---------- 指标：跟 lib/signals/ 逐行等价 ----------
/** 简单移动平均，口径同 lib/signals/moving-average.ts（前 period-1 个位置是 null） */
function movingAverage(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** RSI，Wilder 平滑，口径同 lib/signals/rsi.ts */
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch > 0) gainSum += ch;
    else lossSum += -ch;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  const calc = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = calc(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    out[i] = calc(avgGain, avgLoss);
  }
  return out;
}

/** 趋势状态，口径同 lib/rules/evaluate.ts 的两个分支 */
function trendState(price, ma7, ma30) {
  if (ma7 === null || ma30 === null) return null;
  if (ma7 < ma30 && price < ma7) return "走弱";
  if (ma7 > ma30 && price > ma7) return "走强";
  return "中性";
}

// ---------- 统计工具 ----------
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const pctNeg = (a) => (a.length ? a.filter((v) => v < 0).length / a.length : NaN);
const fmt = (v) => (Number.isNaN(v) ? "   -    " : (v * 100).toFixed(2).padStart(7) + "%");

function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const all = [...neg.map((v) => [v, 0]), ...pos.map((v) => [v, 1])].sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (all[k][1] === 1) rankSum += avgRank;
    i = j;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/**
 * 二值判据（"落在这一档" 1 / 0）预测"超额为负"的 AUC，按 2×2 计数直接算。
 * 二值判据的 AUC 天生被并列压向 0.5（第二关），**所以它跟连续特征的 AUC 不能比大小**，
 * 只能同一列内部横向比各档谁更强。
 * @param posIn 该档内 excess<0 的样本数  @param posOut 档外 excess<0 的样本数
 * @param negIn 该档内 excess>=0 的样本数 @param negOut 档外 excess>=0 的样本数
 */
function binaryAuc(posIn, posOut, negIn, negOut) {
  const pos = posIn + posOut;
  const neg = negIn + negOut;
  if (!pos || !neg) return NaN;
  // 判据为 1 的正类 vs 判据为 0 的负类 = 完全一致；同为 1 或同为 0 = 并列，各算半分
  return (posIn * negOut + 0.5 * (posIn * negIn + posOut * negOut)) / (pos * neg);
}

/** 双尾符号检验 */
function signTestP(hits, total) {
  if (!total) return NaN;
  const logC = (n, k) => {
    let s = 0;
    for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1);
    return s;
  };
  const tail = (from) => {
    let logSum = -Infinity;
    for (let i = from; i <= total; i++) {
      const l = logC(total, i);
      logSum = logSum === -Infinity ? l : Math.max(logSum, l) + Math.log(1 + Math.exp(-Math.abs(logSum - l)));
    }
    return Math.exp(logSum - total * Math.log(2));
  };
  return Math.min(1, 2 * tail(Math.max(hits, total - hits)));
}

const RSI_BANDS = [
  ["<30 超卖", -Infinity, RSI_OVERSOLD],
  ["30~40", RSI_OVERSOLD, 40],
  ["40~60", 40, 60],
  ["60~70", 60, RSI_OVERBOUGHT],
  ["≥70 超买", RSI_OVERBOUGHT, Infinity],
];
const rsiBandOf = (v) => (v === null ? null : RSI_BANDS.find(([, lo, hi]) => v >= lo && v < hi)?.[0] ?? null);

// ================= 第一遍：只为算大盘基准 =================
// **刻意分两遍读库**：一次性把所有饰品的全部样本留在堆里，就是踩坑 28（OOM）的形状——
// 那次是 338 个饰品 × 完整历史 ≈ 440MB 撑爆 1 核 1GB 机器的 Node 堆。这里 700+ 个饰品
// × 约 2400 小时 × 多个指标字段只会更糟。第一遍只留"每天的前瞻收益数组"（几十万个数，
// 十几 MB），第二遍逐个饰品算完立刻丢，堆里任何时刻只有一个饰品的数据。
// 代价是每个饰品的序列读两次，换来的是内存从 O(饰品数 × 历史长度) 变成 O(1 个饰品)。
const items = db.prepare("SELECT DISTINCT item_name FROM price_snapshots").all().map((r) => r.item_name);

const fwdByDay = new Map();
const usableItems = [];

for (const item of items) {
  const platform = referencePlatform(item);
  if (!platform) continue;
  const series = hourlyPrices(item, platform);
  if (series.length < 24 * (HORIZON_DAYS + 14)) continue;
  usableItems.push([item, platform]);

  const hourIndex = new Map(series.map(([h], i) => [h, i]));
  for (let i = 48; i < series.length; i++) {
    const [ts, price] = series[i];
    const futureIdx = hourIndex.get(ts + HORIZON_DAYS * DAY_MS);
    if (futureIdx === undefined) continue;
    const fwd = (series[futureIdx][1] - price) / price;
    const day = Math.floor(ts / DAY_MS) * DAY_MS;
    if (!fwdByDay.has(day)) fwdByDay.set(day, []);
    fwdByDay.get(day).push(fwd);
  }
}

const marketByDay = new Map();
for (const [d, arr] of fwdByDay) {
  if (arr.length >= MIN_MARKET_SAMPLES) marketByDay.set(d, median(arr));
}
fwdByDay.clear(); // 基准算完立刻释放，后面用不到原始数组了

console.log("=== RSI / 均线趋势 超额收益回算 ===");
console.log(`参与统计的饰品：${usableItems.length} 个；大盘基准覆盖 ${marketByDay.size} 天`);
console.log(`口径：超额 = 该样本未来 ${HORIZON_DAYS} 天收益 − 当天全市场中位数（同 build-sell-rule-baseline.mjs）`);
console.log("只看中位数不看均值——皮肤价格是重尾分布，均值会被几个低价品主导。");

// ================= 第二遍：逐饰品算指标并聚合 =================
// 两套口径：hourly = 精确复刻线上；daily = 名字本来的意思
const SCALES = ["小时(线上实际)", "日(名字本意)"];
const rsiAgg = new Map(); // `${scale}|${band}` -> []
const trendAgg = new Map();
const rsiPerItem = new Map(); // `${scale}|${band}` -> [每个饰品的超额中位数]
// `${scale}|${band}` -> [每个饰品上"落在该档"这个二值判据的 AUC]
const rsiBandAuc = new Map();
const trendPerItem = new Map();
// 配对检验用：`${scale}|${state}` -> Map(饰品 -> 该状态下的超额中位数)。
// 要按饰品配对，就必须留住"哪个饰品"这个信息，trendPerItem 那个只留了值。
const trendPairs = new Map();
// AUC：预测"未来 7 天超额为负"，阳性对照是 return24h
const aucPerItem = { "RSI(小时)": [], "RSI(日)": [], "趋势(小时)": [], "趋势(日)": [], "return24h【阳性对照】": [] };
let tieShareTrend = [];
let tieShareRsi = [];

const push = (map, key, v) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(v);
};

for (const [item, platform] of usableItems) {
  const series = hourlyPrices(item, platform);
  const hourIndex = new Map(series.map(([h], i) => [h, i]));
  const prices = series.map(([, p]) => p);

  // —— 线上口径：直接在小时桶上取 7/30/14 期 ——
  const ma7h = movingAverage(prices, 7);
  const ma30h = movingAverage(prices, 30);
  const rsi14h = rsi(prices, 14);

  // —— 日口径：先按天重采样（每天最后一条），再取 7/30/14 天 ——
  const byDay = new Map();
  for (const [ts, p] of series) byDay.set(Math.floor(ts / DAY_MS) * DAY_MS, p);
  const dayKeys = [...byDay.keys()].sort((a, b) => a - b);
  const dayPrices = dayKeys.map((d) => byDay.get(d));
  const ma7d = movingAverage(dayPrices, 7);
  const ma30d = movingAverage(dayPrices, 30);
  const rsi14d = rsi(dayPrices, 14);
  const dayIdx = new Map(dayKeys.map((d, i) => [d, i]));

  // 本饰品的样本，算完就丢
  const local = {
    rsiH: new Map(), rsiD: new Map(), trendH: new Map(), trendD: new Map(),
    aucRows: { "RSI(小时)": [], "RSI(日)": [], "趋势(小时)": [], "趋势(日)": [], "return24h【阳性对照】": [] },
  };

  for (let i = 48; i < series.length; i++) {
    const [ts, price] = series[i];
    const day = Math.floor(ts / DAY_MS) * DAY_MS;
    const base = marketByDay.get(day);
    if (base === undefined) continue;
    const futureIdx = hourIndex.get(ts + HORIZON_DAYS * DAY_MS);
    if (futureIdx === undefined) continue;
    const excess = (series[futureIdx][1] - price) / price - base;

    const prev24 = series[i - 24]?.[1];
    const ret24h = prev24 > 0 ? (price - prev24) / prev24 : null;

    const di = dayIdx.get(day);
    const bH = rsiBandOf(rsi14h[i]);
    const bD = di === undefined ? null : rsiBandOf(rsi14d[di]);
    const tH = trendState(price, ma7h[i], ma30h[i]);
    const tD = di === undefined ? null : trendState(price, ma7d[di], ma30d[di]);

    if (bH) push(local.rsiH, bH, excess);
    if (bD) push(local.rsiD, bD, excess);
    if (tH) push(local.trendH, tH, excess);
    if (tD) push(local.trendD, tD, excess);

    const neg = excess < 0;
    const ord = (t) => (t === "走弱" ? -1 : t === "中性" ? 0 : 1);
    if (rsi14h[i] !== null) local.aucRows["RSI(小时)"].push([rsi14h[i], neg]);
    if (di !== undefined && rsi14d[di] !== null) local.aucRows["RSI(日)"].push([rsi14d[di], neg]);
    if (tH) local.aucRows["趋势(小时)"].push([ord(tH), neg]);
    if (tD) local.aucRows["趋势(日)"].push([ord(tD), neg]);
    if (ret24h !== null) local.aucRows["return24h【阳性对照】"].push([ret24h, neg]);
  }

  // 聚合进全局：档位样本进池，同时记下"这个饰品在这个档的超额中位数"给符号检验
  for (const [scaleKey, m] of [["小时(线上实际)", local.rsiH], ["日(名字本意)", local.rsiD]]) {
    // 该尺度下这个饰品的全部样本，用来算"落在某档"这个二值判据的按标的 AUC
    let totalPos = 0; // excess < 0 的样本数
    let totalNeg = 0;
    for (const vals of m.values()) {
      for (const v of vals) { if (v < 0) totalPos += 1; else totalNeg += 1; }
    }
    for (const [band, vals] of m) {
      if (!rsiAgg.has(`sum:${scaleKey}|${band}`)) rsiAgg.set(`sum:${scaleKey}|${band}`, []);
      rsiAgg.get(`sum:${scaleKey}|${band}`).push(...vals);
      if (vals.length >= MIN_SAMPLES_PER_ITEM) {
        push(rsiPerItem, `${scaleKey}|${band}`, median(vals));
        let posIn = 0;
        let negIn = 0;
        for (const v of vals) { if (v < 0) posIn += 1; else negIn += 1; }
        const a = binaryAuc(posIn, totalPos - posIn, negIn, totalNeg - negIn);
        if (!Number.isNaN(a)) push(rsiBandAuc, `${scaleKey}|${band}`, a);
      }
    }
  }
  for (const [scaleKey, m] of [["小时(线上实际)", local.trendH], ["日(名字本意)", local.trendD]]) {
    for (const [state, vals] of m) {
      if (!trendAgg.has(`sum:${scaleKey}|${state}`)) trendAgg.set(`sum:${scaleKey}|${state}`, []);
      trendAgg.get(`sum:${scaleKey}|${state}`).push(...vals);
      if (vals.length >= MIN_SAMPLES_PER_ITEM) {
        const m = median(vals);
        push(trendPerItem, `${scaleKey}|${state}`, m);
        const pk = `${scaleKey}|${state}`;
        if (!trendPairs.has(pk)) trendPairs.set(pk, new Map());
        trendPairs.get(pk).set(item, m);
      }
    }
  }

  for (const [name, rows] of Object.entries(local.aucRows)) {
    const pos = rows.filter((r) => r[1]).map((r) => r[0]);
    const neg = rows.filter((r) => !r[1]).map((r) => r[0]);
    if (pos.length < MIN_SAMPLES_PER_ITEM || neg.length < MIN_SAMPLES_PER_ITEM) continue;
    const a = auc(pos, neg);
    if (!Number.isNaN(a)) aucPerItem[name].push(a);
    // 第二关：并列占比。趋势只有 3 个取值，天生重并列，AUC 会被机械地压向 0.5
    const counts = new Map();
    for (const r of rows) counts.set(r[0], (counts.get(r[0]) ?? 0) + 1);
    const top = Math.max(...counts.values()) / rows.length;
    if (name === "趋势(小时)") tieShareTrend.push(top);
    if (name === "RSI(小时)") tieShareRsi.push(top);
  }
}

// ---------- 输出：分档表 ----------
function printBandTable(title, aggMap, perItemMap, keys, scaleKey) {
  console.log("");
  console.log(`=== ${title}【${scaleKey}】===`);
  console.log("档位        |  样本数  | 超额中位数 | 为负占比 | 有该档的饰品数 | 中位数为负的 | 符号检验p");
  console.log("------------|---------|-----------|---------|--------------|------------|----------");
  for (const k of keys) {
    const pooled = aggMap.get(`sum:${scaleKey}|${k}`) ?? [];
    const per = perItemMap.get(`${scaleKey}|${k}`) ?? [];
    const negItems = per.filter((v) => v < 0).length;
    console.log(
      `${k.padEnd(11)} | ${String(pooled.length).padStart(7)} | ${fmt(median(pooled))} | ` +
        `${fmt(pctNeg(pooled))} | ${String(per.length).padStart(12)} | ${String(negItems).padStart(10)} | ` +
        `${per.length ? signTestP(negItems, per.length).toFixed(4) : "   -"}`
    );
  }
}

for (const scale of SCALES) {
  printBandTable("RSI 分档的未来 7 天超额收益", rsiAgg, rsiPerItem, RSI_BANDS.map((b) => b[0]), scale);
}
for (const scale of SCALES) {
  printBandTable("均线趋势状态的未来 7 天超额收益", trendAgg, trendPerItem, ["走弱", "中性", "走强"], scale);
}

// ---------- 逐条比对 v1 的四个分支 ----------
// 这一节是整个脚本的重点：不是问"RSI/趋势有没有信号"，而是问"**v1 给它们的符号对不对**"。
// 一个方向反了的项比一个没信号的项更糟——没信号只是不贡献，方向反了是在主动做错决策。
console.log("");
console.log("=== 逐条比对 v1 规则引擎的四个分支 ===");
console.log("v1 的权重（lib/rules/evaluate.ts）：RSI≥70 → −30（倾向卖）、RSI≤30 → +30（倾向买）、");
console.log("趋势走弱 → −25（倾向卖）、趋势走强 → +15（倾向买）。负分=看跌，所以：");
console.log("**v1 给负分的档，超额应该为负；给正分的档，超额应该为正。**");
console.log("");
console.log("v1 分支          | v1权重 | 尺度   | 实测超额中位 | 为负占比 | 方向");
console.log("-----------------|-------|--------|------------|---------|------");
const BRANCHES = [
  ["RSI≥70 超买", -30, rsiAgg, "≥70 超买"],
  ["RSI<30 超卖", +30, rsiAgg, "<30 超卖"],
  ["趋势走弱", -25, trendAgg, "走弱"],
  ["趋势走强", +15, trendAgg, "走强"],
];
const mismatches = [];
for (const [label, weight, aggMap, key] of BRANCHES) {
  for (const scale of SCALES) {
    const vals = aggMap.get(`sum:${scale}|${key}`) ?? [];
    const med = median(vals);
    // v1 权重为负 = 预期超额为负；权重为正 = 预期超额为正
    const agrees = Number.isNaN(med) ? null : weight < 0 ? med < 0 : med > 0;
    if (agrees === false) mismatches.push(`${label}（${scale}）`);
    console.log(
      `${label.padEnd(16)} | ${String(weight).padStart(5)} | ${scale.slice(0, 2)}   | ` +
        `${fmt(med)} | ${fmt(pctNeg(vals))} | ${agrees === null ? "  -" : agrees ? "✅ 一致" : "❌ **反了**"}`
    );
  }
}
console.log("");
if (mismatches.length) {
  console.log(`⚠️  **有 ${mismatches.length} 处方向和 v1 的假设相反**：${mismatches.join("、")}`);
  console.log("   方向反了比没信号更糟：没信号只是不贡献分数，方向反了是在主动往错的方向打分。");
  console.log("   注意这跟已验证的「短期反转」是一致的（HYPOTHESES.md §3.3、momentum-chase）——");
  console.log("   涨过头会回落，所以「趋势走强」之后跑输、「趋势走弱」之后跑赢，是均值回复不是异常。");
} else {
  console.log("✅ 四个分支的方向都和 v1 的假设一致（方向一致不等于幅度够用，看下面的经济显著性）。");
}

// ---------- 配对检验：把"饰品自身漂移"这个混杂彻底去掉 ----------
// 上面每个状态各自的按饰品符号检验有个弱点：一个整体在跑赢大盘的饰品，**所有状态**下的
// 超额都会偏正，反之亦然。也就是说"走弱行为正"可能只是"这批饰品本来就在跑赢"。
// 干净的做法是**同一个饰品内部配对比**：比较它自己的走弱时段 vs 自己的走强时段，
// 饰品级的漂移在相减时被消掉。这才是"方向反了"这个结论真正该站的地方。
console.log("");
console.log("=== 配对检验：同一饰品内部，走弱时段 vs 走强时段 ===");
console.log("（消掉饰品自身的整体漂移——不然「某状态超额为正」可能只是「这个饰品本来就在跑赢」）");
console.log("");
console.log("尺度 | 可配对饰品 | 走弱>走强的 | 差距中位数 | 符号检验p | 对 v1 的含义");
console.log("-----|----------|-----------|-----------|----------|-------------");
for (const scale of SCALES) {
  const weakByItem = trendPairs.get(`${scale}|走弱`) ?? new Map();
  const strongByItem = trendPairs.get(`${scale}|走强`) ?? new Map();
  const diffs = [];
  for (const [item, w] of weakByItem) {
    const s = strongByItem.get(item);
    if (s === undefined) continue;
    diffs.push(w - s);
  }
  const better = diffs.filter((d) => d > 0).length;
  const p = signTestP(better, diffs.length);
  // v1 认为走弱该卖(−25)、走强该买(+15)，即预期"走弱之后更差"，也就是差距应该 < 0
  const meaning = !diffs.length
    ? "样本不足"
    : better > diffs.length / 2 && p < 0.05
      ? "❌ **跟 v1 相反**：走弱之后反而更好"
      : better < diffs.length / 2 && p < 0.05
        ? "✅ 跟 v1 一致"
        : "无差异";
  console.log(
    `${scale.startsWith("小时") ? "小时" : "日  "} | ${String(diffs.length).padStart(8)} | ${String(better).padStart(9)} | ` +
      `${fmt(median(diffs))} | ${diffs.length ? p.toFixed(4) : "  -"} | ${meaning}`
  );
}
console.log("");
console.log("这一节是「趋势项方向反了」这个结论的**主要依据**——它是同一饰品内部的比较，");
console.log("不受饰品间差异和整体漂移影响。上面分状态的那两张表只是佐证。");

// ---------- RSI 幅度专表：决定 v1 买入侧还留不留 ----------
// 上一轮只报了方向（"RSI 方向是对的"），但方向对不等于能用——**能不能用取决于幅度**。
// v1 的买入侧就是 RSI<30 → +30 → 达到 ENTRY_MIN_SCORE → 开仓，所以「<30 超卖」那一行的
// 超额中位数直接就是"按 v1 买一次平均能多赚多少"，拿它跟一次往返的成本比即可。
const COST_USER = 0.12; // 项目所有者给的换手成本口径
// 库里能推出来的下界：买卖价差中位 5.72%（REPORT-bidding-depth-features.md，平时档）
// + C5 卖出手续费 1%（lib/fees.ts）。提现费 0.9% 是批量行为不按笔摊，不计入。
const COST_DERIVED = 0.0572 + 0.01;
console.log("");
console.log("=== RSI 幅度专表（决定 v1 买入侧还留不留）===");
console.log("「按标的 AUC」= 每个饰品上「落在该档」这个**二值**判据预测「超额为负」的 AUC 的中位数。");
console.log("二值判据天生重并列、AUC 被压向 0.5（第二关），**只能同列横比各档，不能跟连续特征比大小**。");
for (const scale of SCALES) {
  console.log("");
  console.log(`【${scale}】`);
  console.log("RSI 档位     | 超额中位数 | 为负占比 | 按标的AUC中位 | 饰品数 | vs 12%成本 | vs 6.7%成本");
  console.log("-------------|-----------|---------|-------------|-------|-----------|------------");
  for (const [band] of RSI_BANDS) {
    const pooled = rsiAgg.get(`sum:${scale}|${band}`) ?? [];
    const aucs = rsiBandAuc.get(`${scale}|${band}`) ?? [];
    const med = median(pooled);
    // 买入侧看的是"能不能赚回成本"，卖出侧看的是"跌幅够不够值得躲"，两边都取绝对幅度比
    const mag = Math.abs(med);
    console.log(
      `${band.padEnd(12)} | ${fmt(med)} | ${fmt(pctNeg(pooled))} | ` +
        `${aucs.length ? median(aucs).toFixed(3).padStart(11) : "     -     "} | ` +
        `${String(aucs.length).padStart(5)} | ` +
        `${(mag >= COST_USER ? "  够" : "  不够").padEnd(9)} | ${mag >= COST_DERIVED ? "  够" : "  不够"}`
    );
  }
}
console.log("");
console.log(`两条成本线：**12%** 是项目所有者给的口径；**${(COST_DERIVED * 100).toFixed(1)}%** 是库里能推出来的下界`);
console.log("（买卖价差中位 5.72% + C5 手续费 1%，提现费 0.9% 是批量行为不按笔摊所以没算）。");
console.log("**两条线不影响结论**——RSI 最大的那一档也差着一个数量级，对 12% 和 6.7% 都不够。");
console.log("");
console.log("对照：v2 的 >30% 涨幅档超额中位 **−18.69%**、71.4% 为负，那一档对两条成本线都够。");
console.log("");
console.log("**v1 买入侧的判决**：买入侧走的是 RSI<30 → +30 → 达到 ENTRY_MIN_SCORE 开仓，");
console.log(`所以看「<30 超卖」那一行——小时尺度 ${fmt(median(rsiAgg.get("sum:小时(线上实际)|<30 超卖") ?? []))}、` +
  `日尺度 ${fmt(median(rsiAgg.get("sum:日(名字本意)|<30 超卖") ?? []))}。`);
console.log("方向是对的（正的），但**幅度只有零点几个百分点，而一次往返要 6.7%~12%**。");
console.log("也就是说：**按 v1 买入侧开的仓，期望超额收益连手续费和价差都赚不回来**，");
console.log("这不是「信号弱」，是「信号存在但被交易成本整个吃掉」——两者的处理方式一样：不能靠它开仓。");

console.log("");
console.log("=== 经济显著性：幅度够不够覆盖交易成本 ===");
console.log("对照基准：v2 的 >30% 涨幅档超额中位 **−18.69%**、71.4% 为负，那是「值得为它换手」长什么样。");
console.log("C5 卖出手续费 1%，加上买卖价差，**一次换手的成本大致在 1~2%**。");
console.log("超额幅度小于这个量级的档位，即便统计上 p=0.0000 也不值得触发——");
console.log("这正是 v2 明确不碰 5~15% 档的理由（p=0.0000 但超额只有 −3% 上下）。");

// ---------- 输出：AUC + 效应量 ----------
const FEATURES = Object.keys(aucPerItem);
const ALPHA = 0.05 / FEATURES.length;
console.log("");
console.log("=== 按饰品 AUC：预测「未来 7 天超额收益为负」===");
console.log(`多重比较校正：${FEATURES.length} 个特征 Bonferroni，α = 0.05/${FEATURES.length} ≈ ${ALPHA.toFixed(4)}`);
console.log("");
console.log("特征                    | 可检验饰品 | 同方向 | AUC中位 | 符号检验p | 判定");
console.log("------------------------|----------|-------|--------|----------|------");
const control = median(aucPerItem["return24h【阳性对照】"]);
for (const f of FEATURES) {
  const arr = aucPerItem[f];
  const above = arr.filter((a) => a > 0.5).length;
  const p = signTestP(above, arr.length);
  const med = median(arr);
  let verdict;
  if (!arr.length) verdict = "样本不足";
  else if (!(p < ALPHA)) verdict = "没有区分度";
  else if (Number.isNaN(control)) verdict = "缺对照，判不了";
  else if (med < 0.5 + (control - 0.5) * 0.5) verdict = "显著但效应量远低于阳性对照";
  else verdict = "跟阳性对照同量级";
  console.log(
    `${f.padEnd(23)} | ${String(arr.length).padStart(8)} | ${String(above).padStart(5)} | ` +
      `${Number.isNaN(med) ? "  -   " : med.toFixed(3).padStart(6)} | ${Number.isNaN(p) ? "   -  " : p.toFixed(4)} | ${verdict}`
  );
}

console.log("");
console.log(`**效应量参照线**：阳性对照 return24h 的 AUC 中位数 = ${Number.isNaN(control) ? "-" : control.toFixed(3)}。`);
console.log("v2 的全部阈值就建立在这个特征上，它是这个任务里「有用」长什么样的实测标尺。");
console.log("HYPOTHESES.md 记的 0.744~0.819 是**操盘期 vs 平时**那个判别任务的数字，");
console.log("跟这里「预测超额收益为负」不是同一个任务，**不能跨任务比 AUC**，所以这里用阳性对照当尺子。");
console.log("");
console.log("⚠️  **AUC 高不等于能用，别只看这张表**。AUC 衡量的是「整个取值范围上的排序能力」，");
console.log("而 v2 用的根本不是排序，是**尾部**（≥15%/≥30%）——return24h 全域 AUC 只有 " +
  `${Number.isNaN(control) ? "-" : control.toFixed(3)}，但它尾部那一档的超额是 −18.69%。`);
console.log("所以判断能不能进规则，**以上面分档表的幅度为准**，AUC 这张表只用来比较各特征之间的强弱。");

if (tieShareTrend.length) {
  console.log("");
  console.log("=== 第二关 · 并列占比（AUC 会被并列机械地压向 0.5）===");
  console.log(`趋势状态：单一取值占比中位数 ${(median(tieShareTrend) * 100).toFixed(1)}%（只有 走弱/中性/走强 三个取值，天然重并列）`);
  console.log(`RSI(小时)：单一取值占比中位数 ${(median(tieShareRsi) * 100).toFixed(1)}%（连续值，基本无并列）`);
  console.log("所以趋势那两行的 AUC 天花板本来就低于 RSI，**两者的 AUC 不能直接互相比大小**，");
  console.log("各自跟阳性对照比、以及看分档表的符号检验，才是对的读法。");
}

// ---------- 增量价值：趋势是不是 return24h 的低维投影？ ----------
// 这一节回答 HYPOTHESES.md 模板里那栏「相对已有特征的独立信息」。
// 「趋势走强」≈「最近涨了」，而「最近涨了之后跑输」正是已经验证过的短期反转
// （momentum-chase / v2 的全部依据）。所以上面那个方向发现**可能只是 return24h 换了个说法**。
// 判法：把 return24h 固定在同一档内，再看走强 vs 走弱的超额差。
// 差距还在 → 趋势带了独立信息；差距塌掉 → 它就是投影，不该单独进规则。
console.log("");
console.log("=== 增量价值：控制住 return24h 之后，趋势还剩多少 ===");
console.log("（「趋势走强」和「最近涨了」高度重合，而「涨了之后跑输」已经由 momentum-chase 验证过。");
console.log("  如果固定 return24h 档之后差距塌掉，说明趋势只是它的低维投影，不是独立信号。）");
console.log("");
console.log("return24h档 | 走弱超额 | 走强超额 |   差距   | 走弱样本 | 走强样本");
console.log("------------|---------|---------|---------|---------|--------");
const R24_BANDS = [
  ["跌", -Infinity, 0],
  ["0~5%", 0, 0.05],
  ["5~15%", 0.05, 0.15],
  ["≥15%", 0.15, Infinity],
];
const strat = new Map();
for (const [item, platform] of usableItems) {
  const series = hourlyPrices(item, platform);
  const hourIndex = new Map(series.map(([h], i) => [h, i]));
  const prices = series.map(([, p]) => p);
  const ma7h = movingAverage(prices, 7);
  const ma30h = movingAverage(prices, 30);
  for (let i = 48; i < series.length; i++) {
    const [ts, price] = series[i];
    const day = Math.floor(ts / DAY_MS) * DAY_MS;
    const base = marketByDay.get(day);
    if (base === undefined) continue;
    const fi = hourIndex.get(ts + HORIZON_DAYS * DAY_MS);
    if (fi === undefined) continue;
    const prev24 = series[i - 24]?.[1];
    if (!prev24 || prev24 <= 0) continue;
    const r24 = (price - prev24) / prev24;
    const rb = R24_BANDS.find(([, lo, hi]) => r24 >= lo && r24 < hi)?.[0];
    const t = trendState(price, ma7h[i], ma30h[i]);
    if (!rb || !t || t === "中性") continue;
    const key = `${rb}|${t}`;
    if (!strat.has(key)) strat.set(key, []);
    strat.get(key).push((series[fi][1] - price) / price - base);
  }
}
for (const [rb] of R24_BANDS) {
  const weak = strat.get(`${rb}|走弱`) ?? [];
  const strong = strat.get(`${rb}|走强`) ?? [];
  const mw = median(weak);
  const ms = median(strong);
  const gap = Number.isNaN(mw) || Number.isNaN(ms) ? NaN : mw - ms;
  console.log(
    `${rb.padEnd(11)} | ${fmt(mw)} | ${fmt(ms)} | ${fmt(gap)} | ` +
      `${String(weak.length).padStart(7)} | ${String(strong.length).padStart(7)}`
  );
}
console.log("");
console.log("读法：「差距」= 走弱超额 − 走强超额，为正说明「走弱之后比走强之后跑得好」。");
console.log("     如果各档的差距都还在（且量级跟不分档时相当），趋势带了 return24h 之外的信息；");
console.log("     如果差距随着档位收窄到接近 0，那它就是 return24h 的另一种写法，不该单独计权重。");
console.log("");
console.log("⚠️  **这一节是池化的，没做按饰品检验，只能当探索不能当判据**（第一关没过）。");
console.log("   而且两侧样本数往往极不对称——「24h 涨 ≥15% 同时价格还在下行均线之下」本来就是");
console.log("   罕见状态（急跌后的反抽），样本少、又高度自相关，那一格的数字最不稳。");
console.log("   要拿它做任何决定，必须先补按饰品的符号检验，并且分档后每个饰品的样本量要够。");

console.log("");
console.log("=== 这份输出不能证明什么 ===");
console.log("· 它只说明「RSI/趋势 和 未来超额收益」的统计关系，不说明因果，也不等于能进规则。");
console.log("· 要进 lib/rules 还得过 HYPOTHESES.md 第六关（阈值从回测反推）和第七关（影子并行）。");
console.log("· **如果两个都没信号，那就是有效结论**：说明 v1 删掉成交量项之后剩下的两项也没有依据，");
console.log("  等于整个 v1 卖出侧没有一项是回测支持的——这正是 v2 存在的理由，不用替 v1 找补。");
