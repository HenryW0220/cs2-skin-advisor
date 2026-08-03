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
//
// 这个脚本负责第 2 条。已验证的两个信号：
//   - **追涨风险**（REPORT-t7-actionable-labels.md）：24h 涨幅 >15% 时未来 7 天平均 -10.74%、
//     70.8% 概率为负。这是**卖出**方向的证据。
//   - **洗盘回撤 drawdown48h**（REPORT-manipulation-playbook-stages.md + 两版预测基线）：
//     最大正权重特征，也就是深回撤之后倾向于反弹——这是**不该卖**的方向的证据，
//     所以下面要看这两个信号叠加时会不会互相抵消。
//
// 口径说明：
//   - 卖出侧不受 T+7 影响（锁定只锁买入后 7 天，持有超过 7 天的仓位随时能卖），
//     所以这里不加锁定期约束，跟买入侧的回测不一样。
//   - 比的是"此刻卖" vs "继续持有 N 天"，用毛收益比较即可——两边都要扣一次手续费，
//     差额上抵消（真实差别只在手续费的时间价值，可忽略）。
//   - 按小时重采样，跟 lib/signals/resample.ts 同口径。
import Database from "better-sqlite3";

const db = new Database("data/db.sqlite", { readonly: true });
const HOUR_MS = 36e5;
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const HORIZONS = [3, 7, 14]; // 天

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

// 涨幅分档。边界特意跨过 15%（已验证的追涨阈值），看它左右两侧是不是真的有台阶
const BANDS = [
  ["跌", -Infinity, 0],
  ["0~5%", 0, 0.05],
  ["5~10%", 0.05, 0.1],
  ["10~15%", 0.1, 0.15],
  ["15~20%", 0.15, 0.2],
  ["20~30%", 0.2, 0.3],
  [">30%", 0.3, Infinity],
];

const items = db.prepare("SELECT DISTINCT item_name FROM price_snapshots").all().map((r) => r.item_name);
const buckets = new Map(); // 档位 -> { horizon -> 收益数组 }
const bucketsWashout = new Map(); // 同上，但只统计"同时处于深回撤"的样本
for (const [label] of BANDS) {
  buckets.set(label, new Map(HORIZONS.map((h) => [h, []])));
  bucketsWashout.set(label, new Map(HORIZONS.map((h) => [h, []])));
}

let itemsUsed = 0;
for (const item of items) {
  const platform = referencePlatform(item);
  if (!platform) continue;
  const series = hourlyPrices(item, platform);
  if (series.length < 24 * 30) continue; // 至少 30 天，否则算不出 14 天前瞻
  itemsUsed += 1;

  const hourIndex = new Map(series.map(([h], i) => [h, i]));
  for (let i = 48; i < series.length; i++) {
    const [ts, price] = series[i];
    const prev24 = series[i - 24]?.[1];
    if (!prev24 || prev24 <= 0) continue;
    const r24 = (price - prev24) / prev24;

    // 48 小时内的最高价回撤幅度，跟 lib/signals/washout.ts 同一个定义
    let peak = 0;
    for (let k = Math.max(0, i - 48); k <= i; k++) peak = Math.max(peak, series[k][1]);
    const drawdown48h = peak > 0 ? (peak - price) / peak : 0;
    const inWashout = drawdown48h > 0.15;

    const band = BANDS.find(([, lo, hi]) => r24 >= lo && r24 < hi);
    if (!band) continue;

    for (const days of HORIZONS) {
      const futureIdx = hourIndex.get(ts + days * 24 * HOUR_MS);
      if (futureIdx === undefined) continue;
      const fwd = (series[futureIdx][1] - price) / price;
      buckets.get(band[0]).get(days).push(fwd);
      if (inWashout) bucketsWashout.get(band[0]).get(days).push(fwd);
    }
  }
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const pctNeg = (a) => (a.length ? a.filter((v) => v < 0).length / a.length : NaN);
const fmt = (v) => (Number.isNaN(v) ? "  -  " : (v * 100).toFixed(2).padStart(6) + "%");

function printTable(title, data) {
  console.log("");
  console.log(title);
  console.log("24h涨幅档  |  样本数 | 未来3天均值 | 未来7天均值 | 未来7天中位 | 7天为负占比 | 未来14天均值");
  console.log("-----------|--------|------------|------------|------------|------------|------------");
  for (const [label] of BANDS) {
    const h7 = data.get(label).get(7);
    console.log(
      `${label.padEnd(10)} | ${String(h7.length).padStart(6)} | ${fmt(mean(data.get(label).get(3)))} | ` +
        `${fmt(mean(h7))} | ${fmt(median(h7))} | ${fmt(pctNeg(h7))} | ${fmt(mean(data.get(label).get(14)))}`
    );
  }
}

console.log(`参与统计的饰品：${itemsUsed} 个（要求至少 30 天历史）`);
printTable("=== 全部样本：此刻的 24h 涨幅 → 之后的收益 ===", buckets);
printTable("=== 只看同时处于深回撤（48h 回撤 >15%）的样本 ===", bucketsWashout);

console.log("");
console.log("读法：某一档的\"未来7天均值\"显著为负、且\"为负占比\"明显过半，才有资格当卖出触发条件；");
console.log("     两张表出现分歧的档位说明洗盘信号会抵消追涨信号，规则里要写成组合条件而不是单条。");
