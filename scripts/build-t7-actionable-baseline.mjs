// T+7 可行动基线：C1/C2 的下一版预测目标（PLAN.md 原则6 / REPORT-C1-C2.md 2026-07-21）。
// 用法：node scripts/build-t7-actionable-baseline.mjs
//
// 旧标签问的是"未来 N 天内会不会进入操盘窗口"——但 2026-07-15 交易保护新规后买入
// 锁 7 天才能卖，这个问题不等于"能不能赚钱"（见 scripts/analyze-t7-forced-hold.mjs：
// 完美买点下也有 60% 的盘 7 天内过峰，快盘预测对了也吃不到）。这版换成直接问
// "此刻买入、强制持有 7 天、第 7 天卖出净收益是否 >0"——不区分是不是操盘，
// 单纯预测 7 天后的价格，天然把只对快盘有效的信号筛掉。
//
// 样本单位、特征、模型（标准化逻辑回归）跟 build-prediction-baseline.mjs 完全一致，
// 只有标签定义和基线不同，所以特征代码是重复的（跟本项目其它 scripts/ 一次性分析
// 脚本同样各自独立成文件的惯例一致，不额外抽公共模块）。
//
// 候选池只用 full（全部跟踪饰品+全市场随机样本）——narrow 池已经证明会虚高
// （REPORT-C1-C2.md），这版不再重复对比。
//
// 新增基线：动量（追涨，按过去24h涨幅排序买入）——这是不用任何模型、随手就能做的
// 策略，模型如果赢不了这个，说明它没有提供任何额外价值。
//
// 结果解读见 REPORT-T7.md，不要只看这里打印出来的数字：第一版直接照抄
// build-prediction-baseline.mjs 的评估方式，同一饰品同一天多个小时级样本没去重，
// 平均收益被极少数孤例严重灌水（已修复，见 evaluateDaily 里的 dedupeByItem）；
// 修复后数字依然被少数几个极端赢家主导，"模型打赢基准"方向可信，具体打赢多少
// 现在样本量下没有统计意义。
import Database from "better-sqlite3";

const db = new Database("data/db.sqlite", { readonly: true });

const HOUR_MS = 3600 * 1000;
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
// 这版不需要跟 build-prediction-baseline.mjs 的 6/29 切分保持一致（那边受 episode
// 跨切分约束限制），拉早一点换更长的测试期——19天测试期太容易被1、2个孤例
// 极端收益主导（实测：单个饰品的3次出现能把平均收益从+1.2%拉到+11.5%），
// 测试期短样本量不够,结论没有统计意义。
const SPLIT_DATE = new Date("2026-06-05T00:00:00Z").getTime();
const HOLD_HOURS = 7 * 24;
const FEE_THRESHOLD = 0.02; // 跟 analyze-t7-forced-hold.mjs 同口径：约1%手续费+滑点余量
const TOP_K = 5;
const RIDGE_LAMBDA = 0.1;
const LEARNING_RATE = 0.3;
const EPOCHS = 500;

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

const allTrackedItems = db.prepare("SELECT DISTINCT item_name FROM price_snapshots").all().map((r) => r.item_name);

const metaByItem = new Map(
  db.prepare("SELECT item_name, collection FROM item_metadata").all().map((r) => [r.item_name, r.collection])
);

// ---------- 联动特征需要全市场同小时收益率（跟 build-prediction-baseline.mjs 同口径） ----------

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

function rollingStats(values, window, index) {
  const from = Math.max(0, index - window);
  const slice = values.slice(from, index);
  if (slice.length < Math.min(window, 24)) return null;
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
  return { mean, std: Math.sqrt(variance) };
}

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

// ---------- 构建样本：标签 = 强制持有7天后净收益是否 >手续费门槛 ----------
// 不排除"已在操盘窗口内"的点——这版问的是"此刻买入是否划算"，跟是不是操盘无关，
// 任何时点都是有效的候选买点。

const samples = [];
let skippedThin = 0;
for (const item of allTrackedItems) {
  const platform = itemPlatform.get(item);
  if (!platform) { skippedThin++; continue; }
  const rows = seriesFor(item, platform);
  if (rows.length < 200) { skippedThin++; continue; }
  const prices = rows.map((r) => r.price);
  const volumes = rows.map((r) => r.volume ?? 0);
  const returns = prices.map((p, i) => (i === 0 || prices[i - 1] <= 0 ? 0 : (p - prices[i - 1]) / prices[i - 1]));
  const siblings = siblingsByItem.get(item) ?? [];

  for (let i = 169; i + HOLD_HOURS < rows.length; i++) {
    const buyPrice = prices[i];
    if (buyPrice <= 0) continue;
    const sellPrice = prices[i + HOLD_HOURS];
    const t7Return = (sellPrice - buyPrice) / buyPrice;

    const ts = new Date(rows[i].captured_at).getTime();
    const retStats = rollingStats(returns, 168, i);
    if (!retStats) continue;
    const volStats = rollingStats(volumes, 168, i);
    const r24 = returns.slice(Math.max(1, i - 24), i);
    const vol24h = Math.sqrt(r24.reduce((s, v) => s + v * v, 0) / r24.length);
    const ma = rollingStats(prices, 168, i);
    const from24 = Math.max(0, i - 24);
    const absReturn24h = prices[from24] > 0 ? Math.abs(prices[i] - prices[from24]) / prices[from24] : 0;
    const signedReturn24h = prices[from24] > 0 ? (prices[i] - prices[from24]) / prices[from24] : 0;

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

    const dateStr = new Date(ts).toISOString().slice(0, 10);
    samples.push({
      item,
      ts,
      dateStr,
      feats,
      t7Return,
      label: t7Return > FEE_THRESHOLD ? 1 : 0,
      signedReturn24h, // 动量基线排序用
    });
  }
}

console.log(`跟踪饰品 ${allTrackedItems.length} 个，数据不足跳过 ${skippedThin} 个`);
console.log(`总样本 ${samples.length}（每个点要求 i+168h 在数据范围内，越靠近数据末尾的点越少）`);
console.log(`时间切分：训练 < ${new Date(SPLIT_DATE).toISOString().slice(0, 10)}，测试 >= 该日期\n`);

// ---------- 逻辑回归 ----------

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
    for (let j = 0; j < dim; j++) weights[j] -= LEARNING_RATE * (gradW[j] / n + RIDGE_LAMBDA * weights[j]);
    bias -= LEARNING_RATE * (gradB / n);
  }
  return { weights, bias };
}

function predict(X, model) {
  return X.map((x) => sigmoid(x.reduce((s, v, j) => s + v * model.weights[j], model.bias)));
}

// ---------- 每日 top-K 评估：精度 + 实际平均 T+7 净收益（比精度更直接地回答"赚不赚钱"） ----------

// 同一饰品同一天有多个小时级样本，分数/收益高度相关（drawdown48h 等特征几小时内
// 不会大变），不去重的话 top-5 很容易被同一个饰品的不同小时占满——那不是5次独立
// 判断，是1个饰品被计数5次，会把平均收益严重灌水（实测抓到过：一个+325%的孤例
// 连续3天把同一饰品塞满5个坑）。每天每个饰品只按给定排序标准保留最优的那个小时，
// 三套策略（模型/随机/动量）各自用自己的排序标准去重，保证每天的5个坑对应5个
// 不同的饰品，这才是"分散买5个真实标的"该有的口径。
function dedupeByItem(candidates, scoreFn) {
  const bestByItem = new Map();
  for (const c of candidates) {
    const score = scoreFn(c);
    const prev = bestByItem.get(c.item);
    if (!prev || score > prev.score) bestByItem.set(c.item, { c, score });
  }
  return [...bestByItem.values()].map((v) => v.c);
}

function evaluateDaily(testSamples, scores, topK) {
  const byDate = new Map();
  testSamples.forEach((s, i) => {
    const list = byDate.get(s.dateStr) ?? [];
    list.push({ ...s, score: scores[i] });
    byDate.set(s.dateStr, list);
  });

  const dates = [...byDate.keys()].sort();
  let modelHits = 0, modelPicks = 0, modelReturnSum = 0;
  let randomExpectedHits = 0, randomExpectedReturn = 0, randomPicks = 0;
  let momHits = 0, momPicks = 0, momReturnSum = 0;

  for (const date of dates) {
    const rawCandidates = byDate.get(date);

    const modelPool = dedupeByItem(rawCandidates, (c) => c.score);
    const kModel = Math.min(topK, modelPool.length);
    if (kModel > 0) {
      const byModel = [...modelPool].sort((a, b) => b.score - a.score).slice(0, kModel);
      modelPicks += kModel;
      if (process.env.DEBUG_PICKS) {
        console.log(date, byModel.map((c) => `${c.item.slice(0, 25)}@${(c.t7Return * 100).toFixed(0)}%`).join(" | "));
      }
      for (const c of byModel) {
        if (c.label === 1) modelHits += 1;
        modelReturnSum += c.t7Return;
      }
    }

    // 随机基准也按去重后的饰品池算期望值，不然候选数会被样本多的饰品（快照更全的）灌水。
    const randomPool = dedupeByItem(rawCandidates, () => Math.random());
    const kRandom = Math.min(topK, randomPool.length);
    if (kRandom > 0) {
      const positives = randomPool.filter((c) => c.label === 1).length;
      randomExpectedHits += kRandom * (positives / randomPool.length);
      randomExpectedReturn += kRandom * (randomPool.reduce((s, c) => s + c.t7Return, 0) / randomPool.length);
      randomPicks += kRandom;
    }

    // 动量基线：不用任何模型，直接买过去24h涨幅最大的k个（追涨），去重标准是它自己的排序依据。
    const momPool = dedupeByItem(rawCandidates, (c) => c.signedReturn24h);
    const kMom = Math.min(topK, momPool.length);
    if (kMom > 0) {
      const byMomentum = [...momPool].sort((a, b) => b.signedReturn24h - a.signedReturn24h).slice(0, kMom);
      momPicks += kMom;
      for (const c of byMomentum) {
        if (c.label === 1) momHits += 1;
        momReturnSum += c.t7Return;
      }
    }
  }

  return {
    modelPrecision: modelPicks ? modelHits / modelPicks : NaN,
    modelAvgReturn: modelPicks ? modelReturnSum / modelPicks : NaN,
    randomPrecision: randomPicks ? randomExpectedHits / randomPicks : NaN,
    randomAvgReturn: randomPicks ? randomExpectedReturn / randomPicks : NaN,
    momPrecision: momPicks ? momHits / momPicks : NaN,
    momAvgReturn: momPicks ? momReturnSum / momPicks : NaN,
    days: dates.length,
  };
}

// ---------- 主流程 ----------

const train = samples.filter((s) => s.ts < SPLIT_DATE);
const test = samples.filter((s) => s.ts >= SPLIT_DATE);
const trainPos = train.filter((s) => s.label === 1).length;
const testPos = test.filter((s) => s.label === 1).length;

console.log(`训练样本 ${train.length}（净赚 ${trainPos}，占比 ${((trainPos / train.length) * 100).toFixed(2)}%）`);
console.log(`测试样本 ${test.length}（净赚 ${testPos}，占比 ${((testPos / test.length) * 100).toFixed(2)}%）\n`);

if (train.length < 100 || test.length < 20 || trainPos < 5) {
  console.log("样本量太小，无法训练，退出。");
  process.exit(0);
}

const { X: trainX, stats } = standardize(train, FEATURE_NAMES);
const { X: testX } = standardize(test, FEATURE_NAMES, stats);
const trainY = train.map((s) => s.label);

const model = trainLogisticRegression(trainX, trainY);
const testScores = predict(testX, model);

const evalResult = evaluateDaily(test, testScores, TOP_K);
console.log(`每日 top-${TOP_K} 评估（测试期 ${evalResult.days} 天，标签=T+7净收益>${FEE_THRESHOLD * 100}%）：\n`);
console.log(`策略          精度@top5   平均T+7净收益`);
console.log(`模型           ${(evalResult.modelPrecision * 100).toFixed(1)}%       ${(evalResult.modelAvgReturn * 100).toFixed(2)}%`);
console.log(`随机           ${(evalResult.randomPrecision * 100).toFixed(1)}%       ${(evalResult.randomAvgReturn * 100).toFixed(2)}%`);
console.log(`动量(追涨24h)   ${(evalResult.momPrecision * 100).toFixed(1)}%       ${(evalResult.momAvgReturn * 100).toFixed(2)}%`);

const beatsRandom = evalResult.modelAvgReturn > evalResult.randomAvgReturn;
const beatsMomentum = evalResult.modelAvgReturn > evalResult.momAvgReturn;
console.log(`\n是否打赢随机基准(按平均净收益): ${beatsRandom ? "是" : "否"}`);
console.log(`是否打赢动量基准(按平均净收益): ${beatsMomentum ? "是" : "否"}`);

console.log("\n特征权重（标准化系数）:");
FEATURE_NAMES.forEach((name, j) => {
  console.log(`  ${name.padEnd(14)} ${model.weights[j].toFixed(3)}`);
});
