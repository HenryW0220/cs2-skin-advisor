// C1+C2：预测模型第一版——数据集构建 + 逻辑回归基线 + 两个笨基准对比。
// 用法：node scripts/build-prediction-baseline.mjs
//
// 样本单位：(饰品, 小时) 时点。标签：从这个时点起，未来 N 天内这个饰品是否会
// 进入操盘窗口（N 取 1/3/7 各评估一遍）。当前已经身处窗口内的时点不参与——
// "预测未来会不会发生"跟"识别正在发生"是两回事，见 lib/signals/manipulation-score.ts。
//
// 硬性门槛（PLAN.md C2）：必须打赢①随机基准②"上级动了就报下级"纯规则基准，
// 赢不了不上线——所以这版直接把三者放在同一份报告里对比，不是只跑模型自己看着好看。
//
// 时间切分：按绝对日期切（2026-06-29 前训练、之后测试），同一操盘窗口不跨切分——
// 只在训练集内出现的窗口用来估计参数，测试集的"未来"对训练阶段完全不可见。
//
// 已知局限（如实写进报告，不藏）：
// 1. 建模总体只用"已标注操盘"的饰品自身的历史（正类窗口内 vs 该饰品自己其它时段），
//    不是全市场随机抽样——PLAN.md 风险4 提到的"模型学成识别你会买什么"的自我实现
//    偏差在这版里没有解决，只是如实报告数字，不代表能直接上线。
// 2. 样本量小（141 个标注窗口，测试期只占约 3 周），指标本身噪声会比较大。
// 3. 求购深度数据（bidding_price/bidding_count）2026-07-20 才开始入库，这版还用不上。
import Database from "better-sqlite3";

const db = new Database("data/db.sqlite", { readonly: true });

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const SPLIT_DATE = new Date("2026-06-29T00:00:00Z").getTime(); // ~78/22 切分，见下方 episode 统计
const LOOKAHEAD_DAYS = [1, 3, 7];
const TOP_K = 5;
const RIDGE_LAMBDA = 0.1;
const LEARNING_RATE = 0.3;
const EPOCHS = 500;

// ---------- 数据准备（跟 analyze-manipulation-features.mjs / analyze-playbook-stages.mjs 同口径） ----------

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

function seriesFor(itemName, platform) {
  return db
    .prepare(
      `SELECT captured_at, price, volume FROM price_snapshots
       WHERE item_name = ? AND platform = ? AND price > 0 ORDER BY captured_at ASC`
    )
    .all(itemName, platform);
}

const taggedItems = [...new Set(db.prepare("SELECT item_name FROM manipulation_tags").all().map((r) => r.item_name))];
const allTrackedItems = db.prepare("SELECT DISTINCT item_name FROM price_snapshots").all().map((r) => r.item_name);

// 同一饰品的标注窗口合并成 episode（间隔 <=3 天视为同一次做盘），跟 B2 报告同口径。
function loadEpisodesByItem() {
  const tags = db
    .prepare("SELECT item_name, start_date, end_date FROM manipulation_tags ORDER BY item_name, start_date")
    .all();
  const byItem = new Map();
  for (const t of tags) {
    const start = new Date(`${t.start_date}T00:00:00Z`).getTime();
    const end = t.end_date ? new Date(`${t.end_date}T00:00:00Z`).getTime() + DAY_MS : start + 3 * DAY_MS;
    const list = byItem.get(t.item_name) ?? [];
    const last = list[list.length - 1];
    if (last && start - last.end <= 3 * DAY_MS) {
      last.end = Math.max(last.end, end);
    } else {
      list.push({ start, end });
    }
    byItem.set(t.item_name, list);
  }
  return byItem;
}
const episodesByItem = loadEpisodesByItem();

const externalByItem = new Map();
for (const e of db.prepare("SELECT item_name, detected_at FROM anomaly_events WHERE status = 'external'").all()) {
  const list = externalByItem.get(e.item_name) ?? [];
  const t = new Date(e.detected_at).getTime();
  list.push([t - DAY_MS, t + DAY_MS]);
  externalByItem.set(e.item_name, list);
}

const metaByItem = new Map(
  db.prepare("SELECT item_name, collection FROM item_metadata").all().map((r) => [r.item_name, r.collection])
);

function inAnyWindow(windows, ts) {
  for (const w of windows) {
    const [s, e] = Array.isArray(w) ? w : [w.start, w.end];
    if (ts >= s && ts < e) return true;
  }
  return false;
}

// 这个时点之后最近一次 episode 开始还要多久（天），没有未来 episode 时返回 Infinity。
// label(N) = daysToNextEpisode <= N；命中时 daysToNextEpisode 本身就是"提前量"。
function daysToNextEpisode(episodes, ts) {
  let nearest = Infinity;
  for (const ep of episodes) {
    if (ep.start > ts) nearest = Math.min(nearest, (ep.start - ts) / DAY_MS);
  }
  return nearest;
}

// ---------- 联动特征需要全市场同小时收益率 ----------

const returnsByItemHour = new Map();
const return24ByItemHour = new Map();
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

const siblingsByItem = new Map();
for (const item of allTrackedItems) {
  const coll = metaByItem.get(item);
  if (!coll) continue;
  siblingsByItem.set(
    item,
    allTrackedItems.filter((o) => o !== item && metaByItem.get(o) === coll && returnsByItemHour.has(o))
  );
}

// ---------- 单点特征（跟 analyze-manipulation-features.mjs 一致）+ 洗盘特征 ----------

function rollingStats(values, window, index) {
  const from = Math.max(0, index - window);
  const slice = values.slice(from, index);
  if (slice.length < Math.min(window, 24)) return null;
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
  return { mean, std: Math.sqrt(variance) };
}

// 与 lib/signals/washout.ts 同阈值/同窗口口径的洗盘特征（这里只算原始值，不算布尔判定）
function washoutFeatures(prices, index, window = 48) {
  if (index < window) return { drawdown48h: 0, volatility48h: 0 };
  const recent = prices.slice(index - window, index + 1);
  const latest = recent[recent.length - 1];
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of recent) {
    peak = Math.max(peak, p);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - p) / peak);
  }
  const drawdown = peak > latest && peak > 0 ? maxDrawdown : 0;
  const rets = [];
  for (let i = 1; i < recent.length; i++) if (recent[i - 1] > 0) rets.push((recent[i] - recent[i - 1]) / recent[i - 1]);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const volatility = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  return { drawdown48h: drawdown, volatility48h: volatility };
}

const FEATURE_NAMES = [
  "absReturn1h",
  "absReturn24h",
  "absZ",
  "vol24h",
  "volumeRatio",
  "maDev",
  "coMove",
  "coMove24h",
  "drawdown48h",
  "volatility48h",
];

// ---------- 构建样本 ----------

// 两套候选池对比着看：
// - narrowPool：只用 53 个已标注饰品自己的历史（正类窗口内 vs 该饰品自己其它时段）——
//   这是"这个饰品本来就容易被操盘"的信息已经泄露进候选池了，精度会虚高。
// - fullPool：全部跟踪饰品（含从没被标注过的），未标注饰品的所有时点都按负类算——
//   更接近真实上线场景"每小时给全部跟踪品打分"，但没标注不等于真的没被操盘过，
//   负类里可能混了看漏的正类，所以这个数字也不是"真值"，只是比 narrowPool 诚实。
const samplesByN = { narrow: { 1: [], 3: [], 7: [] }, full: { 1: [], 3: [], 7: [] } };
const externalSamplesByN = { 1: [], 3: [], 7: [] }; // 外部事件时点单独放，不进训练/正式测试指标

let skippedThin = 0;
const taggedSet = new Set(taggedItems);
for (const item of allTrackedItems) {
  const platform = itemPlatform.get(item);
  if (!platform) { skippedThin++; continue; }
  const rows = seriesFor(item, platform);
  if (rows.length < 200) { skippedThin++; continue; }
  const prices = rows.map((r) => r.price);
  const volumes = rows.map((r) => r.volume ?? 0);
  const returns = prices.map((p, i) => (i === 0 || prices[i - 1] <= 0 ? 0 : (p - prices[i - 1]) / prices[i - 1]));
  const siblings = siblingsByItem.get(item) ?? [];
  const episodes = episodesByItem.get(item) ?? [];
  const externalWindows = externalByItem.get(item) ?? [];

  for (let i = 169; i < rows.length; i++) {
    const ts = new Date(rows[i].captured_at).getTime();
    if (inAnyWindow(episodes, ts)) continue; // 已经在窗口内，不是"预测未来"的时点

    const retStats = rollingStats(returns, 168, i);
    if (!retStats) continue;
    const volStats = rollingStats(volumes, 168, i);
    const r24 = returns.slice(Math.max(1, i - 24), i);
    const vol24h = Math.sqrt(r24.reduce((s, v) => s + v * v, 0) / r24.length);
    const ma = rollingStats(prices, 168, i);
    const from24 = Math.max(0, i - 24);
    const absReturn24h = prices[from24] > 0 ? Math.abs(prices[i] - prices[from24]) / prices[from24] : 0;

    const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
    let coMove = 0;
    let coMove24h = 0;
    for (const sib of siblings) {
      const r = returnsByItemHour.get(sib)?.get(hour);
      if (r !== undefined && Math.abs(r) > 0.01) coMove++;
      const r24s = return24ByItemHour.get(sib)?.get(hour);
      if (r24s !== undefined && Math.abs(r24s) > 0.03) coMove24h++;
    }

    const { drawdown48h, volatility48h } = washoutFeatures(prices, i);

    const feats = {
      absReturn1h: Math.abs(returns[i]),
      absReturn24h,
      absZ: retStats.std > 0 ? Math.abs((returns[i] - retStats.mean) / retStats.std) : 0,
      vol24h,
      volumeRatio: volStats && volStats.mean > 0 ? volumes[i] / volStats.mean : 1,
      maDev: ma && ma.mean > 0 ? Math.abs(prices[i] - ma.mean) / ma.mean : 0,
      coMove,
      coMove24h,
      drawdown48h,
      volatility48h,
    };

    const isExternal = inAnyWindow(externalWindows, ts);
    const dateStr = new Date(ts).toISOString().slice(0, 10);
    const daysToNext = daysToNextEpisode(episodes, ts);

    for (const n of LOOKAHEAD_DAYS) {
      const label = daysToNext <= n ? 1 : 0;
      const sample = { item, ts, dateStr, feats, label, coMove, daysToNext };
      if (isExternal) {
        externalSamplesByN[n].push(sample);
        continue;
      }
      samplesByN.full[n].push(sample);
      if (taggedSet.has(item)) samplesByN.narrow[n].push(sample);
    }
  }
}

console.log(`跟踪饰品 ${allTrackedItems.length} 个（其中已标注 ${taggedItems.length} 个），数据不足跳过 ${skippedThin} 个`);
console.log(`时间切分：训练 < ${new Date(SPLIT_DATE).toISOString().slice(0, 10)}，测试 >= 该日期\n`);

// ---------- 逻辑回归（手写梯度下降，标准化用训练集统计量） ----------

function standardize(rows, dims, stats) {
  if (!stats) {
    stats = dims.map((d) => {
      const vals = rows.map((r) => r.feats[d]);
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
      return { mean, std };
    });
  }
  const X = rows.map((r) => dims.map((d, j) => (r.feats[d] - stats[j].mean) / stats[j].std));
  return { X, stats };
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function trainLogisticRegression(X, y) {
  const n = X.length;
  const dim = X[0].length;
  let weights = new Array(dim).fill(0);
  let bias = 0;
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const gradW = new Array(dim).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, x, j) => s + x * weights[j], bias);
      const pred = sigmoid(z);
      const err = pred - y[i];
      for (let j = 0; j < dim; j++) gradW[j] += err * X[i][j];
      gradB += err;
    }
    for (let j = 0; j < dim; j++) {
      weights[j] -= (LEARNING_RATE * (gradW[j] / n + RIDGE_LAMBDA * weights[j])) ;
    }
    bias -= LEARNING_RATE * (gradB / n);
  }
  return { weights, bias };
}

function predict(X, model) {
  return X.map((x) => sigmoid(x.reduce((s, v, j) => s + v * model.weights[j], model.bias)));
}

// ---------- 每日 top-K 评估 ----------

function evaluateDaily(testSamples, scores, topK) {
  const byDate = new Map();
  testSamples.forEach((s, i) => {
    const list = byDate.get(s.dateStr) ?? [];
    list.push({ ...s, score: scores[i] });
    byDate.set(s.dateStr, list);
  });

  let modelHits = 0, modelPicks = 0;
  let randomExpectedHits = 0, randomPicks = 0;
  let ruleHits = 0, rulePicks = 0;
  const leadTimesModel = [];
  const dates = [...byDate.keys()].sort();

  for (const date of dates) {
    const candidates = byDate.get(date);
    const k = Math.min(topK, candidates.length);
    if (k === 0) continue;

    const byModel = [...candidates].sort((a, b) => b.score - a.score).slice(0, k);
    modelPicks += k;
    for (const c of byModel) {
      if (c.label === 1) {
        modelHits += 1;
        leadTimesModel.push(c.daysToNext);
      }
    }

    // 随机基准：不放回随机抽 k 个的期望命中数 = k * (正类数/candidates 数)
    const positives = candidates.filter((c) => c.label === 1).length;
    randomExpectedHits += k * (positives / candidates.length);
    randomPicks += k;

    // 纯规则基准：coMove>=1 的都算命中候选，按 coMove 降序取前 k（不足 k 用全部）
    const flagged = candidates.filter((c) => c.coMove >= 1).sort((a, b) => b.coMove - a.coMove).slice(0, k);
    rulePicks += flagged.length;
    ruleHits += flagged.filter((c) => c.label === 1).length;
  }

  return {
    modelPrecision: modelPicks ? modelHits / modelPicks : NaN,
    randomPrecision: randomPicks ? randomExpectedHits / randomPicks : NaN,
    rulePrecision: rulePicks ? ruleHits / rulePicks : NaN,
    avgLeadDays: leadTimesModel.length
      ? leadTimesModel.reduce((s, v) => s + v, 0) / leadTimesModel.length
      : NaN,
    modelPicks,
    rulePicks,
    days: dates.length,
  };
}

// ---------- 主流程：两套候选池 × N=1/3/7 各跑一遍 ----------

const fullPoolModels = {}; // 留着给外部事件诊断复用（用全量池训练的模型更接近真实上线场景）

for (const pool of ["narrow", "full"]) {
  console.log(`\n########## 候选池: ${pool === "narrow" ? "仅已标注饰品（虚高）" : "全部跟踪饰品（更接近真实场景）"} ##########`);

  for (const n of LOOKAHEAD_DAYS) {
    const all = samplesByN[pool][n];
    const train = all.filter((s) => s.ts < SPLIT_DATE);
    const test = all.filter((s) => s.ts >= SPLIT_DATE);
    const trainPos = train.filter((s) => s.label === 1).length;
    const testPos = test.filter((s) => s.label === 1).length;

    console.log(`===== N=${n} 天 =====`);
    console.log(`训练样本 ${train.length}（正类 ${trainPos}，占比 ${((trainPos / train.length) * 100).toFixed(2)}%）`);
    console.log(`测试样本 ${test.length}（正类 ${testPos}，占比 ${((testPos / test.length) * 100).toFixed(2)}%）`);

    if (train.length < 100 || test.length < 20 || trainPos < 5) {
      console.log("样本量太小，跳过训练（数字仅供参考，不构成结论）\n");
      continue;
    }

    const { X: trainX, stats } = standardize(train, FEATURE_NAMES);
    const { X: testX } = standardize(test, FEATURE_NAMES, stats);
    const trainY = train.map((s) => s.label);

    const model = trainLogisticRegression(trainX, trainY);
    const testScores = predict(testX, model);
    if (pool === "full") fullPoolModels[n] = { model, stats };

    const evalResult = evaluateDaily(test, testScores, TOP_K);
    console.log(`每日 top-${TOP_K} 评估（测试期 ${evalResult.days} 天）：`);
    console.log(`  模型精度@top-${TOP_K}:   ${(evalResult.modelPrecision * 100).toFixed(1)}%`);
    console.log(`  随机基准精度:          ${(evalResult.randomPrecision * 100).toFixed(1)}%`);
    console.log(`  纯规则基准精度(coMove): ${(evalResult.rulePrecision * 100).toFixed(1)}%（候选数 ${evalResult.rulePicks}）`);
    const beatsRandom = evalResult.modelPrecision > evalResult.randomPrecision;
    const beatsRule = evalResult.modelPrecision > evalResult.rulePrecision;
    console.log(`  是否打赢随机基准: ${beatsRandom ? "是" : "否"}；是否打赢规则基准: ${beatsRule ? "是" : "否"}`);
    console.log(`  命中时平均提前量: ${evalResult.avgLeadDays.toFixed(2)} 天（label 定义是 daysToNext<=N，数值不会超过 N）`);

    // 特征权重（标准化后的系数，绝对值大小反映相对重要性，不是因果）
    console.log("  特征权重（标准化系数）:");
    FEATURE_NAMES.forEach((name, j) => {
      console.log(`    ${name.padEnd(14)} ${model.weights[j].toFixed(3)}`);
    });
    console.log("");
  }
}

console.log("===== 外部事件时点的模型行为（诊断用，不计入正式指标） =====");
console.log("拿全量池训练出来的模型给外部事件时点打分，跟测试集正/负类的平均分对比——");
console.log("如果外部事件的平均分接近正类（操盘），说明模型学到的是「异动」本身而不是「操盘」，是危险信号。\n");
for (const n of LOOKAHEAD_DAYS) {
  const ext = externalSamplesByN[n];
  const fitted = fullPoolModels[n];
  if (!fitted || ext.length === 0) {
    console.log(`N=${n}: 外部事件时点 ${ext.length} 个，模型未训练或无样本，跳过`);
    continue;
  }
  const { X } = standardize(ext, FEATURE_NAMES, fitted.stats);
  const scores = predict(X, fitted.model);
  const avgExternalScore = scores.reduce((s, v) => s + v, 0) / scores.length;

  const test = samplesByN.full[n].filter((s) => s.ts >= SPLIT_DATE);
  const { X: testX } = standardize(test, FEATURE_NAMES, fitted.stats);
  const testScores = predict(testX, fitted.model);
  const posScores = testScores.filter((_, i) => test[i].label === 1);
  const negScores = testScores.filter((_, i) => test[i].label === 0);
  const avgPos = posScores.reduce((s, v) => s + v, 0) / posScores.length;
  const avgNeg = negScores.reduce((s, v) => s + v, 0) / negScores.length;

  console.log(`N=${n}: 外部事件时点 ${ext.length} 个，平均预测分 ${avgExternalScore.toFixed(4)}`);
  console.log(`       对照：测试集正类(操盘)平均分 ${avgPos.toFixed(4)}，负类(平时)平均分 ${avgNeg.toFixed(4)}`);
}
