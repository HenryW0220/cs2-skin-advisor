// 一次性分析脚本：评估"求购深度"（挂单簿的需求侧）能不能区分操盘期和平时。
// 用法：node scripts/analyze-bidding-depth-features.mjs
//
// 为什么单独一个脚本而不是改 analyze-manipulation-features.mjs：那个脚本的 AUC 数字
// 被 HANDOFF 跨多次运行对比着（vol24h 0.72→0.707→0.710 这种趋势），往里面加特征会动到
// 样本口径、破坏可比性。这里复用它的标注口径和 AUC 算法，但样本池是独立的。
//
// 动机（PLAN.md 阶段 B / HANDOFF 四.2）：操盘剧本六阶段里"吸货期"和"出货期"至今
// 在价格形态上分不出独立指纹，一直卡在"只有价格没有挂单数据"。2026-07-20 起
// biddingPrice/biddingCount 开始入库，这是第一次有需求侧数据可用。
// 假设是：吸货期庄家在下方堆求购单（买盘变厚），出货期反过来（卖盘变厚）。
//
// **样本口径的硬约束，看结论前必须知道**：
// 1. 求购数据只有 2026-07-20 之后才有，而 184 条操盘标记里绝大多数窗口在 4~7 月中旬，
//    所以正类样本量比 analyze-manipulation-features.mjs 小一个量级，AUC 的置信区间很宽。
// 2. C5 直连价格接口不返回求购数据（platform='C5' 的行这两列多数是 null），
//    所以参考平台**不能沿用 C5 优先**，这里按"哪个平台的求购数据最多"来选。
// 3. price_snapshots.captured_at 存的是平台 updateTime（那条报价最后一次变动的时间），
//    不是观测时间，冷门品会留在很早的时间戳上——按真实时间做时序分析必须按
//    captured_at 过滤掉 BIDDING_DATA_START 之前的行，否则会混进一批陈旧时间戳。
import Database from "better-sqlite3";

const db = new Database("data/db.sqlite", { readonly: true });

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BIDDING_DATA_START = "2026-07-20";
const MIN_ROWS_PER_ITEM = 100; // 少于这个数算不出 168 小时基线，直接跳过

// ---------- 标注（口径跟 analyze-manipulation-features.mjs 一致）----------

const tagsByItem = new Map();
for (const t of db.prepare("SELECT * FROM manipulation_tags").all()) {
  const list = tagsByItem.get(t.item_name) ?? [];
  // end_date 为空按开始日 +3 天算窗口
  const start = new Date(`${t.start_date}T00:00:00Z`).getTime();
  const end = t.end_date ? new Date(`${t.end_date}T00:00:00Z`).getTime() + DAY_MS : start + 3 * DAY_MS;
  list.push([start, end]);
  tagsByItem.set(t.item_name, list);
}

const externalByItem = new Map();
for (const e of db
  .prepare("SELECT item_name, detected_at FROM anomaly_events WHERE status = 'external'")
  .all()) {
  const list = externalByItem.get(e.item_name) ?? [];
  const t = new Date(e.detected_at).getTime();
  list.push([t - DAY_MS, t + DAY_MS]);
  externalByItem.set(e.item_name, list);
}

function labelFor(itemName, ts) {
  for (const [s, e] of tagsByItem.get(itemName) ?? []) if (ts >= s && ts < e) return "manip";
  for (const [s, e] of externalByItem.get(itemName) ?? []) if (ts >= s && ts < e) return "external";
  return "normal";
}

// ---------- 取数 ----------

// 按"求购数据最多"选参考平台。沿用 C5 优先会让绝大多数饰品拿不到求购数据（见文件头第 2 条）。
function biddingPlatform(itemName) {
  const row = db
    .prepare(
      `SELECT platform, COUNT(*) n FROM price_snapshots
       WHERE item_name = ? AND bidding_count IS NOT NULL AND price > 0 AND captured_at >= ?
       GROUP BY platform ORDER BY n DESC LIMIT 1`
    )
    .get(itemName, BIDDING_DATA_START);
  return row && row.n >= MIN_ROWS_PER_ITEM ? row.platform : null;
}

// 同一小时可能有多条（高频 tick），只留每小时最后一条，跟 lib/signals/resample.ts 同口径
function hourlySeries(itemName, platform) {
  const rows = db
    .prepare(
      `SELECT captured_at, price, volume, bidding_price, bidding_count
       FROM price_snapshots
       WHERE item_name = ? AND platform = ? AND price > 0
         AND bidding_count IS NOT NULL AND captured_at >= ?
       ORDER BY captured_at ASC`
    )
    .all(itemName, platform, BIDDING_DATA_START);
  const byHour = new Map();
  for (const r of rows) {
    byHour.set(Math.floor(new Date(r.captured_at).getTime() / HOUR_MS) * HOUR_MS, r);
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]);
}

function rollingMean(values, window, index) {
  const from = Math.max(0, index - window);
  const slice = values.slice(from, index);
  if (slice.length < Math.min(window, 24)) return null;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

// ---------- 特征 ----------

const FEATURES = [
  ["bidCount", "求购挂单数（原始值）"],
  ["bidRatio", "求购数 / 自身168h均值"],
  ["bidAskRatio", "求购数 / 在售数（买卖盘厚度比）"],
  ["bidAskRatioRel", "买卖盘厚度比 / 自身168h均值"],
  ["bidSpread", "(在售价-求购价)/在售价，买卖价差"],
  ["bidCountChg24h", "求购数24小时变化率"],
];

const samples = { manip: [], normal: [], external: [] };
const itemsWithData = [];

const taggedItems = db.prepare("SELECT DISTINCT item_name FROM manipulation_tags").all().map((r) => r.item_name);

for (const item of taggedItems) {
  const platform = biddingPlatform(item);
  if (!platform) continue;
  const series = hourlySeries(item, platform);
  if (series.length < MIN_ROWS_PER_ITEM) continue;
  itemsWithData.push(`${item} (${platform}, ${series.length}h)`);

  const bidCounts = series.map(([, r]) => r.bidding_count ?? 0);
  const bidAsk = series.map(([, r]) => {
    const ask = r.volume ?? 0;
    return ask > 0 ? (r.bidding_count ?? 0) / ask : 0;
  });

  for (let i = 24; i < series.length; i++) {
    const [ts, row] = series[i];
    const bidMean = rollingMean(bidCounts, 168, i);
    const bidAskMean = rollingMean(bidAsk, 168, i);
    const prev24 = bidCounts[i - 24];

    samples[labelFor(item, ts)].push({
      bidCount: bidCounts[i],
      bidRatio: bidMean && bidMean > 0 ? bidCounts[i] / bidMean : 1,
      bidAskRatio: bidAsk[i],
      bidAskRatioRel: bidAskMean && bidAskMean > 0 ? bidAsk[i] / bidAskMean : 1,
      bidSpread:
        row.price > 0 && row.bidding_price != null ? (row.price - row.bidding_price) / row.price : 0,
      bidCountChg24h: prev24 > 0 ? (bidCounts[i] - prev24) / prev24 : 0,
    });
  }
}

// ---------- 评估 ----------

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

// AUC：随机取一个操盘样本和一个平时样本，操盘样本该特征更大的概率（0.5=无区分度）
function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const all = [...neg.map((v) => [v, 0]), ...pos.map((v) => [v, 1])].sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avgRank = (i + j + 1) / 2; // 并列值取平均秩
    for (let k = i; k < j; k++) if (all[k][1] === 1) rankSum += avgRank;
    i = j;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

console.log(`求购数据起始：${BIDDING_DATA_START}（此前的行没有这两个字段，已按 captured_at 过滤）`);
console.log(`有操盘标记且有足够求购数据的饰品：${itemsWithData.length} 个`);
console.log(`样本量: 操盘期 ${samples.manip.length} | 平时 ${samples.normal.length} | 外部事件期 ${samples.external.length}`);
console.log("");

if (samples.manip.length < 200) {
  console.log("⚠️  操盘期样本不足 200 条，下面的 AUC 只能当趋势看，不足以支撑上线决策。");
  console.log("");
}

console.log("特征               | 操盘期中位数  | 平时中位数    | 外部事件中位数 | AUC(操盘vs平时)");
console.log("-------------------|--------------|--------------|--------------|--------");
for (const [f, desc] of FEATURES) {
  const m = median(samples.manip.map((s) => s[f]));
  const n = median(samples.normal.map((s) => s[f]));
  const e = median(samples.external.map((s) => s[f]));
  const a = auc(samples.manip.map((s) => s[f]), samples.normal.map((s) => s[f]));
  console.log(
    `${f.padEnd(18)} | ${m.toFixed(4).padStart(12)} | ${n.toFixed(4).padStart(12)} | ${e.toFixed(4).padStart(12)} | ${a.toFixed(3)}   ${desc}`
  );
}

console.log("");
console.log("参与统计的饰品：");
for (const s of itemsWithData) console.log("  " + s);
