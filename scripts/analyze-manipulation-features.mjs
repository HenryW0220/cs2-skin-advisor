// 一次性分析脚本：对比"操盘窗口内"和"平时"的行情特征分布，评估每个候选特征的区分度。
// 用法：node scripts/analyze-manipulation-features.mjs
// 结论用来决定操盘检测第一版（lib/signals/manipulation-score）选哪些特征——
// 不要凭直觉挑指标，用真实标注算出来的 AUC 说话。
//
// 标签来源：manipulation_tags（操盘窗口，正类）；anomaly_events 里 status=external 的
// 日期（外部事件，单独统计不进正负类）；其余时段是负类（平时）。
// 数据是每小时一条的 price_snapshots（K线回填 + 定时同步）。
import Database from "better-sqlite3";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "analyze-manipulation-features",
  usage: "node scripts/analyze-manipulation-features.mjs [库文件]",
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const db = new Database(resolveDbPath(args.dbPath), { readonly: true });

const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------- 数据准备 ----------

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

const taggedItems = db
  .prepare("SELECT DISTINCT item_name FROM manipulation_tags")
  .all()
  .map((r) => r.item_name);
const allTrackedItems = db
  .prepare("SELECT DISTINCT item_name FROM price_snapshots")
  .all()
  .map((r) => r.item_name);

const tagsByItem = new Map();
for (const t of db.prepare("SELECT * FROM manipulation_tags").all()) {
  const list = tagsByItem.get(t.item_name) ?? [];
  // end_date 为空按开始日+3天算窗口
  const start = new Date(`${t.start_date}T00:00:00Z`).getTime();
  const end = t.end_date
    ? new Date(`${t.end_date}T00:00:00Z`).getTime() + DAY_MS
    : start + 3 * DAY_MS;
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

const metaByItem = new Map(
  db.prepare("SELECT item_name, collection FROM item_metadata").all().map((r) => [r.item_name, r.collection])
);

// ---------- 特征计算 ----------

function seriesFor(itemName, platform) {
  return db
    .prepare(
      `SELECT captured_at, price, volume FROM price_snapshots
       WHERE item_name = ? AND platform = ? AND price > 0 ORDER BY captured_at ASC`
    )
    .all(itemName, platform);
}

function rollingStats(values, window, index) {
  // index 处不含自身的过去 window 期均值/标准差
  const from = Math.max(0, index - window);
  const slice = values.slice(from, index);
  if (slice.length < Math.min(window, 24)) return null;
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
  return { mean, std: Math.sqrt(variance) };
}

// 每个饰品的每小时收益率，做同收藏品联动特征用
const returnsByItemHour = new Map(); // itemName -> Map(hourTs -> return)
const itemPlatform = new Map();
for (const item of allTrackedItems) {
  const platform = referencePlatform(item);
  if (!platform) continue;
  itemPlatform.set(item, platform);
  const rows = seriesFor(item, platform);
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].price;
    if (prev <= 0) continue;
    const hour = Math.floor(new Date(rows[i].captured_at).getTime() / HOUR_MS) * HOUR_MS;
    map.set(hour, (rows[i].price - prev) / prev);
  }
  returnsByItemHour.set(item, map);
}

const siblingsByItem = new Map();
for (const item of allTrackedItems) {
  const coll = metaByItem.get(item);
  if (!coll) continue;
  siblingsByItem.set(
    item,
    allTrackedItems.filter((o) => o !== item && metaByItem.get(o) === coll && returnsByItemHour.has(o))
  );
}

function labelFor(itemName, ts) {
  for (const [s, e] of tagsByItem.get(itemName) ?? []) if (ts >= s && ts < e) return "manip";
  for (const [s, e] of externalByItem.get(itemName) ?? []) if (ts >= s && ts < e) return "external";
  return "normal";
}

const FEATURES = [
  "absReturn1h", // 1小时涨跌幅绝对值
  "absReturn24h", // 24小时累计涨跌幅绝对值
  "absZ", // 收益率相对自身168h基线的 |z-score|
  "vol24h", // 24小时滚动波动率
  "volumeRatio", // 挂单量相对7天均值的倍数
  "maDev", // 价格偏离 MA168 的幅度
  "coMove", // 同收藏品其他饰品同小时 |涨跌|>1% 的数量
  "coMove24h", // 同收藏品其他饰品同一天 |24h涨跌|>3% 的数量
];

// 每个饰品的 24h 收益率（按小时对齐），联动特征用
const return24ByItemHour = new Map();
for (const [item, map] of returnsByItemHour) {
  // 用价格序列直接算：这里简化为把小时收益率在窗口内累乘
  const hours = [...map.keys()].sort((a, b) => a - b);
  const r24 = new Map();
  for (const h of hours) {
    let acc = 1;
    for (let k = 0; k < 24; k++) {
      const r = map.get(h - k * HOUR_MS);
      if (r !== undefined) acc *= 1 + r;
    }
    r24.set(h, acc - 1);
  }
  return24ByItemHour.set(item, r24);
}

const samples = { manip: [], normal: [], external: [] };
// 按饰品分开再留一份。**下面主表的池化 AUC 会虚高**：同一个饰品的一波行情贡献几百条
// 高度自相关的小时样本，名义样本量远大于有效样本量。2026-08-03 在求购深度分析里踩到
// 这一点（REPORT-bidding-depth-features.md）——那边六个特征按饰品拆开之后，
// 能立住的两个跟池化排序**不一样**。主表保持原样是为了跟历次运行可比，
// 按饰品检验作为附加一节追加在后面，判据以附加那节为准。
const perItem = new Map();

for (const item of taggedItems) {
  const platform = itemPlatform.get(item);
  if (!platform) continue;
  const rows = seriesFor(item, platform);
  if (rows.length < 200) continue;
  const prices = rows.map((r) => r.price);
  const volumes = rows.map((r) => r.volume ?? 0);
  const returns = prices.map((p, i) => (i === 0 || prices[i - 1] <= 0 ? 0 : (p - prices[i - 1]) / prices[i - 1]));
  const siblings = siblingsByItem.get(item) ?? [];

  for (let i = 169; i < rows.length; i++) {
    const ts = new Date(rows[i].captured_at).getTime();
    const retStats = rollingStats(returns, 168, i);
    if (!retStats) continue;
    const volStats = rollingStats(volumes, 168, i);
    const r24 = returns.slice(Math.max(1, i - 24), i);
    const vol24 = Math.sqrt(r24.reduce((s, v) => s + v * v, 0) / r24.length);
    const ma = rollingStats(prices, 168, i);

    const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
    let coMove = 0;
    let coMove24h = 0;
    for (const sib of siblings) {
      const r = returnsByItemHour.get(sib)?.get(hour);
      if (r !== undefined && Math.abs(r) > 0.01) coMove++;
      const r24 = return24ByItemHour.get(sib)?.get(hour);
      if (r24 !== undefined && Math.abs(r24) > 0.03) coMove24h++;
    }

    const from24 = Math.max(0, i - 24);
    const absReturn24h = prices[from24] > 0 ? Math.abs(prices[i] - prices[from24]) / prices[from24] : 0;

    const label = labelFor(item, ts);
    const feat = {
      absReturn1h: Math.abs(returns[i]),
      absReturn24h,
      absZ: retStats.std > 0 ? Math.abs((returns[i] - retStats.mean) / retStats.std) : 0,
      vol24h: vol24,
      volumeRatio: volStats && volStats.mean > 0 ? volumes[i] / volStats.mean : 1,
      maDev: ma && ma.mean > 0 ? Math.abs(prices[i] - ma.mean) / ma.mean : 0,
      coMove,
      coMove24h,
    };
    samples[label].push(feat);
    if (!perItem.has(item)) perItem.set(item, { manip: [], normal: [], external: [] });
    perItem.get(item)[label].push(feat);
  }
}

// ---------- 区分度评估 ----------

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

console.log(`样本量: 操盘期 ${samples.manip.length} | 平时 ${samples.normal.length} | 外部事件期 ${samples.external.length}`);
console.log("");
console.log("特征           | 操盘期中位数  | 平时中位数    | 外部事件中位数 | AUC(操盘vs平时)");
console.log("---------------|--------------|--------------|--------------|--------");
for (const f of FEATURES) {
  const m = median(samples.manip.map((s) => s[f]));
  const n = median(samples.normal.map((s) => s[f]));
  const e = median(samples.external.map((s) => s[f]));
  const a = auc(samples.manip.map((s) => s[f]), samples.normal.map((s) => s[f]));
  console.log(
    `${f.padEnd(14)} | ${m.toFixed(4).padStart(12)} | ${n.toFixed(4).padStart(12)} | ${e.toFixed(4).padStart(12)} | ${a.toFixed(3)}`
  );
}

// ---------- 附加：按饰品检验（2026-08-03 加，判据以这一节为准）----------
// 上面那张表的分母是"小时样本数"，但同一饰品的一波行情能贡献几百条自相关样本。
// 特征真的有区分度的话，应该**多数饰品各自**都呈现同方向，而不是靠少数几个饰品的
// 长窗口把池化统计量拉起来。符号检验：特征无效时每个饰品 AUC>0.5 是抛硬币。
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
console.log("=== 按饰品检验（池化 AUC 会被自相关虚高，判据看这里）===");
console.log("特征           | 可检验饰品数 | AUC>0.5 的 | 各饰品AUC中位数 | 符号检验 p | 退化剔除");
console.log("---------------|------------|-----------|----------------|------------|--------");
for (const f of FEATURES) {
  const aucs = [];
  let degenerate = 0;
  for (const [, s] of perItem) {
    if (s.manip.length < 24 || s.normal.length < 24) continue; // 至少各一天
    const pos = s.manip.map((x) => x[f]);
    const neg = s.normal.map((x) => x[f]);
    // 取值全相同的饰品对这个特征没有信息量，AUC 会机械地等于 0.5——
    // 算进去会把"命中数/总数"稀释到看起来像抛硬币，制造假阴性。
    // coMove 就踩过这个：67 个有标记的饰品里只有 33 个有收藏品信息，
    // 另外 34 个的 coMove 恒为 0，不剔除的话这个特征永远显得没信号。
    if (new Set([...pos, ...neg]).size <= 1) {
      degenerate++;
      continue;
    }
    const a = auc(pos, neg);
    if (!Number.isNaN(a)) aucs.push(a);
  }
  const above = aucs.filter((a) => a > 0.5).length;
  console.log(
    `${f.padEnd(14)} | ${String(aucs.length).padStart(6)} | ${String(above).padStart(9)} | ` +
      `${median(aucs).toFixed(3).padStart(14)} | ${signTestP(above, aucs.length).toFixed(4).padStart(10)} | ${degenerate}`
  );
}
