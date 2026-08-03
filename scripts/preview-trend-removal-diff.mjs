// 预览"删掉规则引擎趋势项"对 325 个饰品的影响。用法：node scripts/preview-trend-removal-diff.mjs
//
// **只读，不改任何代码，也不写库。** 这份清单是给人看的——按 HYPOTHESES.md 第七关，
// 这次跟清成交量死信号不是一回事：那次实测证明了分支不可达、删掉等价于 no-op；
// **这次会真的改变 /positions 上给人看的建议**，所以要先把差异摆出来让人过目。
//
// ---- 为什么可以离线算，不用改代码跑一遍 ----
// v1 的 score 只由两项相加而成（成交量项 2026-08-03 已删）：
//   RSI：超买 −30 / 超卖 +30 / 其余 0
//   趋势：走弱 −25 / 走强 +15 / 其余 0
// 两项组合出的 9 个值**互不相同**，所以从 score 能唯一反解出是哪两个分量：
//   −55=超买+走弱  −30=超买  −25=走弱  −15=超买+走强  0=无
//   +5=超卖+走弱   +15=走强  +30=超卖  +45=超卖+走强
// 删掉趋势项之后的新 score 就是"只剩 RSI 分量"。脚本会校验库里每个 score 都在这 9 个
// 值里，出现意外值就报错退出——那说明反解前提已经不成立（比如有人加了新的打分项）。
import Database from "better-sqlite3";

const db = new Database(process.argv[2] ?? "data/db.sqlite", { readonly: true });

// 跟 lib/rules/evaluate.ts 保持一致
const SCORE_SELL_THRESHOLD = -40;
const SCORE_TRIM_THRESHOLD = -15;
// 跟 lib/paper-trading.ts 保持一致
const ENTRY_MIN_SCORE = 30;
const MIN_ENTRY_PRICE = 1;

/** score → { rsi, trend }，反解不出来返回 null */
const DECOMPOSE = new Map([
  [-55, { rsi: -30, trend: -25 }],
  [-30, { rsi: -30, trend: 0 }],
  [-25, { rsi: 0, trend: -25 }],
  [-15, { rsi: -30, trend: 15 }],
  [0, { rsi: 0, trend: 0 }],
  [5, { rsi: 30, trend: -25 }],
  [15, { rsi: 0, trend: 15 }],
  [30, { rsi: 30, trend: 0 }],
  [45, { rsi: 30, trend: 15 }],
]);

// action 的口径跟 lib/signal-precompute.ts 一致：固定按 holding=true 算
// （观察池页面只读 score 不读 action）
function pickAction(score) {
  if (score <= SCORE_SELL_THRESHOLD) return "SELL";
  if (score <= SCORE_TRIM_THRESHOLD) return "TRIM";
  return "HOLD";
}

const rows = db
  .prepare("SELECT item_name, platform, market_price, action, score FROM item_signal_summaries ORDER BY item_name")
  .all();

// 观察池成员 + 已有未平仓模拟仓，用来判断"score 跨过门槛后是否真的会开仓"
const watchlist = new Set(db.prepare("SELECT DISTINCT item_name FROM watchlist").all().map((r) => r.item_name));
const openTrades = new Set(
  db.prepare("SELECT DISTINCT item_name FROM paper_trades WHERE status='open'").all().map((r) => r.item_name)
);

console.log("=== 删除趋势项的 action 差异清单（只读预览）===");
console.log(`饰品数 ${rows.length}；观察池 ${watchlist.size} 个；当前未平仓模拟仓涉及 ${openTrades.size} 个饰品`);

// ---- 先校验反解前提 ----
const unknown = rows.filter((r) => !DECOMPOSE.has(r.score));
if (unknown.length) {
  console.error("");
  console.error(`❌ 有 ${unknown.length} 个饰品的 score 不在已知的 9 个可达值里，反解前提不成立：`);
  for (const r of unknown.slice(0, 10)) console.error(`   ${r.score}  ${r.item_name}`);
  console.error("说明规则引擎的打分项变了。**先去核对 lib/rules/evaluate.ts，不要用这份清单。**");
  process.exit(1);
}
console.log("✅ 全部 score 都能唯一反解成 RSI + 趋势两个分量，可以继续");

// ---- 逐个算新旧 ----
const diffs = rows.map((r) => {
  const parts = DECOMPOSE.get(r.score);
  const newScore = parts.rsi; // 删掉趋势项 = 只剩 RSI 分量
  return {
    ...r,
    oldScore: r.score,
    newScore,
    oldAction: r.action,
    newAction: pickAction(newScore),
    trendPart: parts.trend,
  };
});

// ---- score 迁移矩阵 ----
console.log("");
console.log("=== score 迁移（旧 → 新）===");
console.log("旧score | 组成            | 新score | 饰品数 | 旧action → 新action");
console.log("--------|-----------------|--------|-------|--------------------");
const byTransition = new Map();
for (const d of diffs) {
  const k = `${d.oldScore}`;
  if (!byTransition.has(k)) byTransition.set(k, []);
  byTransition.get(k).push(d);
}
const compose = (s) => {
  const p = DECOMPOSE.get(s);
  const rsi = p.rsi === -30 ? "超买" : p.rsi === 30 ? "超卖" : "—";
  const tr = p.trend === -25 ? "走弱" : p.trend === 15 ? "走强" : "—";
  return `RSI ${rsi} / 趋势 ${tr}`;
};
for (const [, arr] of [...byTransition.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const d = arr[0];
  const changed = d.oldAction !== d.newAction;
  console.log(
    `${String(d.oldScore).padStart(7)} | ${compose(d.oldScore).padEnd(16)} | ${String(d.newScore).padStart(6)} | ` +
      `${String(arr.length).padStart(5)} | ${d.oldAction} → ${d.newAction}${changed ? "   ← **变了**" : ""}`
  );
}

// ---- action 变化汇总（这是 /positions 上肉眼可见的部分）----
console.log("");
console.log("=== /positions 上肉眼可见的变化（action 变了的）===");
const actionChanged = diffs.filter((d) => d.oldAction !== d.newAction);
if (!actionChanged.length) {
  console.log("没有饰品的 action 会变。");
} else {
  const byAct = new Map();
  for (const d of actionChanged) {
    const k = `${d.oldAction} → ${d.newAction}`;
    if (!byAct.has(k)) byAct.set(k, []);
    byAct.get(k).push(d);
  }
  for (const [k, arr] of [...byAct.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${k}：${arr.length} 个饰品`);
  }
  console.log("");
  console.log(`共 ${actionChanged.length} / ${rows.length} 个饰品的建议会变（${((100 * actionChanged.length) / rows.length).toFixed(1)}%）。`);
}

// ---- 重点：会新增开仓的那批 ----
// 开仓判据见 lib/paper-trading.ts：观察池成员、score ≥ ENTRY_MIN_SCORE、价格 ≥ MIN_ENTRY_PRICE、
// 当前没有未平仓的同名仓位（再开仓冷却这里查不了，需要 closed_at，单独标注）
console.log("");
console.log("=== 重点：跨过开仓门槛、会新增模拟开仓的饰品 ===");
console.log(`（判据：score 从 <${ENTRY_MIN_SCORE} 升到 ≥${ENTRY_MIN_SCORE}，且在观察池、价格 ≥ ¥${MIN_ENTRY_PRICE}、当前无未平仓同名仓位）`);
const crossed = diffs.filter((d) => d.oldScore < ENTRY_MIN_SCORE && d.newScore >= ENTRY_MIN_SCORE);
console.log("");
console.log(`score 跨过 ${ENTRY_MIN_SCORE} 门槛的：${crossed.length} 个饰品`);
const from5 = crossed.filter((d) => d.oldScore === 5);
console.log(`  其中 +5 → +30（超卖+走弱，趋势项本来在压低它）：${from5.length} 个 ← **这就是新增开仓的主来源**`);
const others = crossed.filter((d) => d.oldScore !== 5);
if (others.length) {
  const g = new Map();
  for (const d of others) g.set(d.oldScore, (g.get(d.oldScore) ?? 0) + 1);
  console.log(`  其他跨门槛的：${[...g.entries()].map(([s, n]) => `${s}→${DECOMPOSE.get(s).rsi} ×${n}`).join("、")}`);
}

const wouldOpen = crossed.filter(
  (d) => watchlist.has(d.item_name) && d.market_price >= MIN_ENTRY_PRICE && !openTrades.has(d.item_name)
);
const blockedNotWatch = crossed.filter((d) => !watchlist.has(d.item_name));
const blockedHasOpen = crossed.filter((d) => watchlist.has(d.item_name) && openTrades.has(d.item_name));
const blockedPrice = crossed.filter(
  (d) => watchlist.has(d.item_name) && !openTrades.has(d.item_name) && d.market_price < MIN_ENTRY_PRICE
);
console.log("");
console.log(`**真正会新增开仓的：${wouldOpen.length} 个饰品**`);
console.log(`  被挡住的：不在观察池 ${blockedNotWatch.length}、已有未平仓仓位 ${blockedHasOpen.length}、价格 <¥${MIN_ENTRY_PRICE} ${blockedPrice.length}`);
console.log("  注：再开仓冷却（平仓后 7 天）这里没算——当前 0 笔平仓，暂时不影响；有平仓记录后要补上。");

if (wouldOpen.length) {
  console.log("");
  console.log("会新增开仓的饰品清单（按价格降序，前 30）：");
  console.log("  旧score→新score |    市场价 | 饰品");
  for (const d of [...wouldOpen].sort((a, b) => b.market_price - a.market_price).slice(0, 30)) {
    console.log(
      `  ${String(d.oldScore).padStart(7)}→${String(d.newScore).padEnd(7)} | ${("¥" + d.market_price.toFixed(2)).padStart(9)} | ${d.item_name}`
    );
  }
  if (wouldOpen.length > 30) console.log(`  ...（共 ${wouldOpen.length} 个）`);
}

// ---- 卖出建议消失的那批 ----
console.log("");
console.log("=== 反方向：卖出/减仓建议会消失的饰品 ===");
const lostSell = diffs.filter(
  (d) => (d.oldAction === "SELL" || d.oldAction === "TRIM") && d.newAction === "HOLD"
);
console.log(`${lostSell.length} 个饰品从 ${["SELL", "TRIM"].join("/")} 变成 HOLD`);
if (lostSell.length) {
  const g = new Map();
  for (const d of lostSell) g.set(`${d.oldScore}(${compose(d.oldScore)})`, (g.get(`${d.oldScore}(${compose(d.oldScore)})`) ?? 0) + 1);
  for (const [k, n] of g) console.log(`   来自 score ${k}：${n} 个`);
  console.log("");
  console.log("这批全是「只有趋势走弱、RSI 正常」的饰品——而回算结果说趋势走弱之后超额是**正的**");
  console.log("（+0.34%/+0.37%，配对检验 578/713、p=0.0000），也就是说这些减仓建议本来方向就是反的。");
}

console.log("");
console.log("=== 怎么读这份清单 ===");
console.log("· 删趋势项在**卖出侧**是纠错：消失的减仓建议本来方向就反（走弱之后反而跑赢）。");
console.log("· 但在**买入侧**是放开闸门：+5→+30 会让一批饰品跨过 ENTRY_MIN_SCORE 开始开仓，");
console.log("  而 RSI 买入侧的超额只有零点几个百分点、连 6.7%~12% 的换手成本都赚不回来。");
console.log("  **也就是说：只删趋势项、不动 ENTRY_MIN_SCORE，会让模拟盘开出更多注定亏成本的仓。**");
console.log("· 所以这两件事应该一起决定，不要只做一半。");
