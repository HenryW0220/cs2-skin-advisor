// 把历史上被判"没区分度"的特征，用 2026-08-03 那三关重新过一遍。
// 用法：node scripts/recheck-degenerate-features.mjs（云端容器里跑）
//
// **只读脚本。不改任何生产代码，不动 analyze-manipulation-features.mjs**
// （那个的 AUC 数字被跨多次运行对比着，往里加东西会破坏可比性）。
//
// 为什么要有这个：coMove 被"没区分度"跟踪了四次、四份记录（0.500→0.507→0.518→0.520），
// 2026-08-03 换了检验方法后发现结论是反的——34 个饰品对它退化、把命中率稀释成了抛硬币。
// 那次的收益是推翻了一条跟踪四次的错误结论，成本是一个只读脚本。同样的方法还没有
// 系统地套在别的旧结论上，这个脚本就是补这一遍。
//
// ---- 三关（HANDOFF 踩坑 44）----
// 第一关 · 自相关：池化 AUC 的分母是"小时样本数"，但同一饰品的一波行情能贡献几百条
//   高度相关的样本，名义样本量远大于有效样本量。→ 按饰品各自算 AUC + 对命中饰品数
//   做符号检验，判据以后者为准。
// 第二关 · 退化样本：某特征对一部分饰品恒为常数时，那些饰品的 AUC 会**机械地等于
//   0.5**（全并列），把整体命中率稀释成抛硬币。→ 统计每个饰品上该特征的取值数，
//   把退化饰品显式剔除并报出剔了多少。**"中位数恰好等于 0.500"本身就是退化的强烈信号**
//   ——真正无效的特征会在 0.5 附近抖，不会精确落在 0.5。
// 第三关 · 量纲：跟标的规模有关的绝对水平会被"贵价品/廉价品天差地别"污染，池化统计量
//   会把选择效应当信号。→ 每个特征同时给"原始"和"除以自身 168h 基线"两个版本。
//
// ---- 复检名单 ----
// absReturn1h  池化 AUC 0.52~0.53，REPORT-prediction-baseline.md 记的是"几乎无区分度"，
//              两版预测模型里权重都接近 0。1 小时涨跌幅对低价品是被报价精度量化过的
//              （¥0.02→¥0.03 就是 50%），而且绝大多数小时根本没动 = 大量并列 0，
//              第二关和第三关都可能命中。
// absZ         42/67、p=0.0249，记的是"勉强"。介于"能用"和"不能用"之间的特征最值得
//              重查——它离判据边界最近，一点方法学偏差就能改变结论。
// volumeRatio  29/67、p=0.889。**这是阴性对照，不是候选**：它已经被两条独立路径确认
//              是死信号（任务 1 刚把它从生产代码里删掉）。放进来是为了检验**方法本身**
//              ——如果这三关把 volumeRatio 也"救活"了，那说明是方法在造信号，
//              这一整份输出都不能信。没有阴性对照的复检等于自说自话。
// bidSpread    9/16、p=0.402，REPORT-bidding-depth-features.md 写的是"别再试了"。
//              样本只有 16 个饰品，本来就在统计功效的边缘。
import Database from "better-sqlite3";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "recheck-degenerate-features",
  usage: "node scripts/recheck-degenerate-features.mjs [库文件]",
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const db = new Database(resolveDbPath(args.dbPath), { readonly: true });

const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_ROWS_PER_ITEM = 200;
// 一个饰品要参与按饰品检验，正负两类各自至少要有这么多小时样本。
// 低于这个数的饰品 AUC 噪声太大，算进来只会稀释符号检验。
const MIN_SAMPLES_PER_CLASS = 12;

// ---------- 标签与数据（口径跟 analyze-manipulation-features.mjs 一致，代码不共用：
// 那个脚本明令不许改，复制一份读取逻辑比引入依赖安全）----------
function referencePlatform(itemName) {
  const rows = db
    .prepare(
      `SELECT platform, COUNT(*) n FROM price_snapshots
       WHERE item_name = ? AND price > 0 GROUP BY platform ORDER BY n DESC`
    )
    .all(itemName);
  for (const p of PLATFORM_PRIORITY) {
    const hit = rows.find((r) => r.platform === p);
    if (hit && hit.n >= MIN_ROWS_PER_ITEM) return p;
  }
  return rows[0]?.n >= MIN_ROWS_PER_ITEM ? rows[0].platform : null;
}

/**
 * 挂单类特征要单独选平台：**C5 直连价格接口不返回求购价/求购数**，而 referencePlatform
 * 优先挑 C5，拿它去算 bidSpread 会得到一整列 null（第一版就是这么写的，六个特征里
 * 两个挂单特征直接变成"0 个可检验饰品"）。这里改挑求购数据最多的那个平台。
 * 求购数据 2026-07-20 才开始入库，绝大多数操盘标记在那之前，所以可检验饰品本来就少。
 */
function biddingPlatform(itemName) {
  const row = db
    .prepare(
      `SELECT platform, COUNT(*) n FROM price_snapshots
       WHERE item_name = ? AND price > 0 AND bidding_price IS NOT NULL
       GROUP BY platform ORDER BY n DESC LIMIT 1`
    )
    .get(itemName);
  return row && row.n >= MIN_SAMPLES_PER_CLASS * 2 ? row.platform : null;
}

const tagsByItem = new Map();
for (const t of db.prepare("SELECT * FROM manipulation_tags").all()) {
  const list = tagsByItem.get(t.item_name) ?? [];
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

// 按小时重采样，每桶留最后一条（口径同 lib/signals/resample.ts）
function hourlySeries(itemName, platform) {
  const rows = db
    .prepare(
      `SELECT captured_at, price, volume, bidding_price, bidding_count FROM price_snapshots
       WHERE item_name = ? AND platform = ? AND price > 0 ORDER BY captured_at ASC`
    )
    .all(itemName, platform);
  const byHour = new Map();
  for (const r of rows) byHour.set(Math.floor(Date.parse(r.captured_at) / HOUR_MS) * HOUR_MS, r);
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]);
}

function rollingStats(values, window, index) {
  const from = Math.max(0, index - window);
  const slice = values.slice(from, index);
  if (slice.length < Math.min(window, 24)) return null;
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
  return { mean, std: Math.sqrt(variance) };
}

// ---------- 统计工具 ----------
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const all = [...neg.map((v) => [v, 0]), ...pos.map((v) => [v, 1])].sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avgRank = (i + j + 1) / 2; // 并列取平均秩
    for (let k = i; k < j; k++) if (all[k][1] === 1) rankSum += avgRank;
    i = j;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/** 双尾符号检验：total 次里 hits 次同方向，纯随机（p=0.5）下的概率 */
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
  const k = Math.max(hits, total - hits);
  return Math.min(1, 2 * tail(k));
}

/**
 * 一个饰品上这个特征退化到什么程度。
 * 判据是取值数：全常数（1 个取值）时 AUC 必然是 0.5，那不是"没信号"是"没数据"。
 * 并列比例高（比如 90% 的样本都是同一个值）时 AUC 也会被强烈拉向 0.5。
 */
function degeneracy(values) {
  const distinct = new Set(values).size;
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const topShare = values.length ? Math.max(...counts.values()) / values.length : 1;
  return { distinct, topShare };
}

// ---------- 特征定义 ----------
// rel=true 的是"除以自身 168h 基线"的版本，用来过第三关。
const FEATURES = [
  ["absReturn1h", "1小时涨跌幅绝对值", "价格"],
  ["absReturn1hRel", "1小时涨跌幅 / 自身168h平均波动（过第三关）", "价格"],
  ["absZ", "收益率相对自身168h基线的 |z-score|", "价格"],
  ["volumeRatio", "在售量 / 自身168h均值【阴性对照】", "量"],
  ["bidSpread", "(在售价-求购价)/在售价", "挂单"],
  ["bidSpreadRel", "买卖价差 / 自身168h均值（过第三关）", "挂单"],
];

const taggedItems = db.prepare("SELECT DISTINCT item_name FROM manipulation_tags").all().map((r) => r.item_name);

const perItem = new Map(); // item -> { manip:[feat], normal:[feat] }
const pooled = { manip: [], normal: [] };

/** 把一组特征值并进 perItem/pooled。价格类和挂单类分两趟跑，因为参考平台不同。 */
function collect(item, label, feat) {
  pooled[label].push(feat);
  if (!perItem.has(item)) perItem.set(item, { manip: [], normal: [] });
  perItem.get(item)[label].push(feat);
}

let priceItems = 0;
let bidItems = 0;

for (const item of taggedItems) {
  // ---- 价格/量类特征：走常规参考平台 ----
  const platform = referencePlatform(item);
  if (platform) {
    const series = hourlySeries(item, platform);
    if (series.length >= MIN_ROWS_PER_ITEM) {
      priceItems += 1;
      const prices = series.map(([, r]) => r.price);
      const volumes = series.map(([, r]) => r.volume ?? 0);
      const returns = prices.map((p, i) =>
        i === 0 || prices[i - 1] <= 0 ? 0 : (p - prices[i - 1]) / prices[i - 1]
      );
      const absReturns = returns.map(Math.abs);

      for (let i = 169; i < series.length; i++) {
        const label = labelFor(item, series[i][0]);
        if (label === "external") continue; // 外部事件单独一类，不进正负类（同 analyze 脚本）
        const retStats = rollingStats(returns, 168, i);
        if (!retStats) continue;
        const volStats = rollingStats(volumes, 168, i);
        const absRetStats = rollingStats(absReturns, 168, i);
        collect(item, label, {
          absReturn1h: absReturns[i],
          absReturn1hRel: absRetStats && absRetStats.mean > 0 ? absReturns[i] / absRetStats.mean : null,
          absZ: retStats.std > 0 ? Math.abs((returns[i] - retStats.mean) / retStats.std) : null,
          volumeRatio: volStats && volStats.mean > 0 ? volumes[i] / volStats.mean : null,
          bidSpread: null,
          bidSpreadRel: null,
        });
      }
    }
  }

  // ---- 挂单类特征：必须走有求购数据的平台，C5 那条路上这两列恒为 null ----
  const bidPlat = biddingPlatform(item);
  if (!bidPlat) continue;
  const bidSeries = hourlySeries(item, bidPlat).filter(([, r]) => r.bidding_price != null);
  if (bidSeries.length < MIN_SAMPLES_PER_CLASS * 2) continue;
  bidItems += 1;

  const spreads = bidSeries.map(([, r]) => (r.price - r.bidding_price) / r.price);
  for (let i = 24; i < bidSeries.length; i++) {
    const label = labelFor(item, bidSeries[i][0]);
    if (label === "external") continue;
    const hist = spreads.slice(Math.max(0, i - 168), i);
    const mean = hist.length >= 24 ? hist.reduce((s, v) => s + v, 0) / hist.length : null;
    collect(item, label, {
      absReturn1h: null,
      absReturn1hRel: null,
      absZ: null,
      volumeRatio: null,
      bidSpread: spreads[i],
      bidSpreadRel: mean && mean > 0 ? spreads[i] / mean : null,
    });
  }
}

console.log("=== 复检：历史上被判'没区分度'的特征 ===");
console.log(`有操盘标记的饰品：价格类可用 ${priceItems} 个 | 挂单类可用 ${bidItems} 个`);
console.log(`池化样本：操盘期 ${pooled.manip.length} 小时 | 平时 ${pooled.normal.length} 小时`);
console.log("");
console.log("**只读脚本，没有改任何生产代码。**");

// ---------- 第一关：池化 vs 按饰品 ----------
console.log("");
console.log("=== 第一关 · 自相关：池化 AUC 和按饰品 AUC 差多少 ===");
console.log("池化的分母是小时样本数，但同一饰品的一波行情贡献几百条高度相关的样本。");
console.log("");
console.log("特征                | 池化AUC | 可检验饰品 | 同方向 | 按饰品AUC中位 | 符号检验p");
console.log("--------------------|--------|----------|-------|-------------|----------");

const perFeature = new Map();
for (const [f] of FEATURES) {
  const pooledAuc = auc(
    pooled.manip.map((s) => s[f]).filter((v) => v !== null),
    pooled.normal.map((s) => s[f]).filter((v) => v !== null)
  );

  const rows = [];
  for (const [item, buckets] of perItem) {
    const pos = buckets.manip.map((s) => s[f]).filter((v) => v !== null);
    const neg = buckets.normal.map((s) => s[f]).filter((v) => v !== null);
    if (pos.length < MIN_SAMPLES_PER_CLASS || neg.length < MIN_SAMPLES_PER_CLASS) continue;
    const a = auc(pos, neg);
    if (Number.isNaN(a)) continue;
    rows.push({ item, auc: a, deg: degeneracy([...pos, ...neg]) });
  }

  const above = rows.filter((r) => r.auc > 0.5).length;
  perFeature.set(f, { pooledAuc, rows });
  console.log(
    `${f.padEnd(19)} | ${pooledAuc.toFixed(3).padStart(6)} | ${String(rows.length).padStart(8)} | ` +
      `${String(above).padStart(5)} | ${median(rows.map((r) => r.auc)).toFixed(3).padStart(11)} | ` +
      `${signTestP(above, rows.length).toFixed(4)}`
  );
}

// ---------- 第二关：退化样本 ----------
console.log("");
console.log("=== 第二关 · 退化样本：剔除该特征恒为常数/几乎全并列的饰品 ===");
console.log("全并列时 AUC 机械地等于 0.5，会把命中率稀释成抛硬币（coMove 就是这么被埋了四次）。");
console.log("这里把'取值数 ≤2'或'单一取值占比 ≥90%'的饰品判为退化。");
console.log("");
console.log("特征                | 退化饰品 | 剩余 | 同方向 | 按饰品AUC中位 | 符号检验p | AUC恰好0.500的");
console.log("--------------------|--------|-----|-------|-------------|----------|-------------");
for (const [f] of FEATURES) {
  const { rows } = perFeature.get(f);
  const exactlyHalf = rows.filter((r) => Math.abs(r.auc - 0.5) < 1e-12).length;
  const kept = rows.filter((r) => r.deg.distinct > 2 && r.deg.topShare < 0.9);
  const above = kept.filter((r) => r.auc > 0.5).length;
  console.log(
    `${f.padEnd(19)} | ${String(rows.length - kept.length).padStart(6)} | ${String(kept.length).padStart(3)} | ` +
      `${String(above).padStart(5)} | ${median(kept.map((r) => r.auc)).toFixed(3).padStart(11)} | ` +
      `${signTestP(above, kept.length).toFixed(4).padStart(8)} | ${String(exactlyHalf).padStart(11)}`
  );
  perFeature.get(f).kept = kept;
}
console.log("");
console.log("读法：'AUC 恰好 0.500 的'那一列不为 0，就是退化的直接证据——真正无效的特征会在");
console.log("     0.5 附近抖动，不会精确落在 0.5 上。剔除前后 p 值大幅变化的，旧结论要重新审。");

// ---------- 第三关：量纲 ----------
console.log("");
console.log("=== 第三关 · 量纲：原始值 vs 除以自身 168h 基线 ===");
console.log("跟标的规模有关的绝对水平，会被'贵价品/廉价品天差地别'污染，池化时把选择效应当信号。");
console.log("");
const PAIRS = [
  ["absReturn1h", "absReturn1hRel"],
  ["bidSpread", "bidSpreadRel"],
];
console.log("原始特征            → 归一化后        | 原始p    | 归一化p  | 结论");
console.log("--------------------------------------|---------|---------|------");
for (const [raw, rel] of PAIRS) {
  const a = perFeature.get(raw).kept ?? [];
  const b = perFeature.get(rel).kept ?? [];
  const pa = signTestP(a.filter((r) => r.auc > 0.5).length, a.length);
  const pb = signTestP(b.filter((r) => r.auc > 0.5).length, b.length);
  let verdict = "两版都不显著，量纲不是原因";
  if (pb < 0.05 && !(pa < 0.05)) verdict = "**归一化后才立住——旧结论是量纲问题**";
  else if (pa < 0.05 && pb < 0.05) verdict = "两版都显著";
  else if (pa < 0.05 && !(pb < 0.05)) verdict = "归一化后反而垮了，原始版可能是选择效应";
  console.log(`${raw.padEnd(19)} → ${rel.padEnd(16)} | ${pa.toFixed(4)}  | ${pb.toFixed(4)}  | ${verdict}`);
}

// ---------- 收尾：判据 + 阴性对照 ----------
const ALPHA = 0.05 / FEATURES.length; // Bonferroni，跟 REPORT-bidding-depth-features.md 同口径
// **效应量下限**。这一关是 2026-08-03 那三关之外补的，理由：符号检验只回答"方向是不是
// 一致"，样本够多时 AUC 0.53 也能给出 p=0.0000，但 0.53 意味着"随机挑一个操盘小时和一个
// 平时小时，操盘那个数值更大的概率是 53%"——离能用差得远。生产里在用的三个特征各饰品
// AUC 中位数是 0.744~0.819，求购深度那两个能立住的是 0.747。所以取 0.60 作为
// "值得继续看"的下限，够不到的即便 p 极小也只是统计显著、不是经济显著
// （这跟卖出规则 v2 里"5~15% 档 p=0.0000 但不进规则"是同一条判据）。
const MIN_USEFUL_AUC = 0.6;
console.log("");
console.log("=== 结论 ===");
console.log(`多重比较校正：${FEATURES.length} 个特征做 Bonferroni，α = 0.05/${FEATURES.length} ≈ ${ALPHA.toFixed(4)}`);
console.log(`效应量下限：各饰品 AUC 中位数 ≥ ${MIN_USEFUL_AUC}（生产在用的三个是 0.744~0.819，作参照）`);
console.log("");
console.log("特征                | 剩余饰品 | 同方向 | AUC中位 | p       | 过α? | 够大? | 判定");
console.log("--------------------|--------|-------|--------|---------|-----|------|------");
for (const [f, desc] of FEATURES) {
  const kept = perFeature.get(f).kept ?? [];
  const above = kept.filter((r) => r.auc > 0.5).length;
  const p = signTestP(above, kept.length);
  const med = median(kept.map((r) => r.auc));
  const significant = p < ALPHA && above > kept.length / 2;
  const bigEnough = med >= MIN_USEFUL_AUC;
  const verdict = !kept.length
    ? "样本不足，判不了"
    : significant && bigEnough
      ? "**值得跟进**"
      : significant
        ? "统计显著但效应量太小，旧结论方向没错"
        : "确认没有区分度";
  console.log(
    `${f.padEnd(19)} | ${String(kept.length).padStart(6)} | ${String(above).padStart(5)} | ` +
      `${Number.isNaN(med) ? "  -   " : med.toFixed(3).padStart(6)} | ${Number.isNaN(p) ? "  -    " : p.toFixed(4)} | ` +
      `${significant ? "是 " : "否 "} | ${bigEnough ? "是  " : "否  "} | ${verdict}` +
      (desc.includes("阴性对照") ? "  ← 阴性对照" : "")
  );
}

const control = perFeature.get("volumeRatio").kept ?? [];
const controlAbove = control.filter((r) => r.auc > 0.5).length;
const controlP = signTestP(controlAbove, control.length);
console.log("");
console.log("**先看阴性对照**：volumeRatio 已被两条独立路径确认是死信号（在售量是存量，");
console.log("小时尺度上不动；2026-08-03 已从生产代码删除）。它在这三关下应该仍然不显著。");
console.log(
  controlP < ALPHA
    ? `⚠️  阴性对照被"救活"了（p=${controlP.toFixed(4)} < α）——**这说明方法本身在造信号，上面所有结论都不能信**，先去查这三关的实现。`
    : `✅ 阴性对照仍不显著（p=${controlP.toFixed(4)}），方法没有系统性地把噪音变成信号，上面的结论可以往下读。`
);
console.log("");
console.log("**注意这份输出能证明什么、不能证明什么**：过了 α 只说明'这个特征在操盘期和平时的");
console.log("分布不同'，不等于能进生产。要进 lib/signals/manipulation-score.ts 还得有独立于");
console.log("现有三个特征（vol24h / absReturn24h / maDev）的增量，以及足够校准阈值的样本量。");
console.log("**这个脚本不改任何生产代码，也不该被当成改动的授权。**");
