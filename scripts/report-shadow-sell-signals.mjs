// 影子卖出规则 v2 的并行期成绩单。用法：node scripts/report-shadow-sell-signals.mjs（云端容器里跑）
//
// 项目所有者定的口径：v2 替换现有卖出规则之前，要先和现有规则并行跑至少一轮，
// **给出触发次数和假信号率**再谈替换。这个脚本就是出那份数字的。
//
// 假信号怎么判（写清楚免得以后口径漂）：
//   一条 SELL/SELL_STRONG 信号，如果发出后 7 天价格**没跌**（相对当天全市场中位数的超额
//   收益 ≥ 0），就算假信号——因为卖了反而错过。用超额而不是绝对涨跌，是因为这段时间
//   大盘一直在跌，不扣基准的话什么都"卖对了"，那是 beta 不是规则的功劳
//   （2026-07-30 模拟盘归因那次就是这么被误导的）。
//   HOLD 判反了同理：HOLD 之后 7 天超额显著为负 = 该卖没卖。
//
// 还没到 7 天的信号会单独列出来标"未到期"，不计入命中率——不能拿没结论的样本充数。
//
// ---- 2026-08-03 之五起，"触发次数"的含义变了，读数字前必须知道 ----
// 模拟盘的平仓判定已经交给 v2（lib/paper-trading.ts），所以**一笔仓位一旦被判 SELL/
// SELL_STRONG 就立刻平掉、从此不再出现在这张表里**。后果：
//   · 每笔仓位最多贡献**一条**卖出类记录，不再是"持续卖出状态每天补记一条"；
//   · 因此卖出类的绝对条数会明显低于纯影子期的预期，**这是机制变了不是信号变少了**，
//     别拿它跟 8-03 之前的估算直接比；
//   · HOLD 那类不受影响（不平仓的仓位继续每天补记），所以卖出类/HOLD 的**比例**
//     也不能再直接当"信号密度"读。
// 命中率本身仍然有效：它查的是 decided_at 之后 7 天的实际走势，跟仓位平没平无关。
// 想看平仓侧的收益，用 scripts/report-paper-trades.mjs——两边是同一次 v2 判定。
import Database from "better-sqlite3";
import { assertBaselineTable, baselineProvenance, loadBaseline } from "./market-baseline-store.mjs";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "report-shadow-sell-signals",
  usage: "node scripts/report-shadow-sell-signals.mjs [库文件]",
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const db = new Database(resolveDbPath(args.dbPath), { readonly: true });
const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
const HORIZON_DAYS = 7;

const signals = db.prepare("SELECT * FROM shadow_sell_signals ORDER BY decided_at ASC").all();
if (!signals.length) {
  console.log("还没有影子信号记录。模拟盘每小时跑一轮，且只对过了 T+7 的仓位记录——");
  console.log("刚部署的话等一两轮整点同步再来看。");
  process.exit(0);
}

console.log(`影子信号总数：${signals.length}`);
console.log(`记录区间：${signals[0].decided_at} ~ ${signals[signals.length - 1].decided_at}`);
console.log("");

const byAction = new Map();
for (const s of signals) byAction.set(s.action, (byAction.get(s.action) ?? 0) + 1);
console.log("=== 触发次数 ===");
for (const [action, n] of [...byAction.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${action.padEnd(12)} ${n} 条（涉及 ${new Set(signals.filter((s) => s.action === action).map((s) => s.item_name)).size} 个饰品）`);
}
const sellCount = (byAction.get("SELL") ?? 0) + (byAction.get("SELL_STRONG") ?? 0);
console.log(`  —— 其中卖出类共 ${sellCount} 条，占 ${((100 * sellCount) / signals.length).toFixed(1)}%`);
console.log("");
console.log("对照：现有规则 v1 在同一批仓位上的触发次数是 0（结构上永远够不到 SELL 阈值，HANDOFF 踩坑 43）。");

// ---------- 算每条信号 7 天后的超额收益 ----------
const priceAt = db.prepare(
  `SELECT price FROM price_snapshots
   WHERE item_name = ? AND platform = ? AND price > 0
     AND captured_at >= ? AND captured_at < ?
   ORDER BY captured_at ASC LIMIT 1`
);

function forwardReturn(signal) {
  const target = Date.parse(signal.decided_at) + HORIZON_DAYS * DAY_MS;
  if (target > Date.now()) return null; // 还没到期
  // 允许 6 小时的容差：同步偶尔会错过整点，卡死在精确时刻会白丢样本
  const row = priceAt.get(
    signal.item_name,
    signal.platform,
    new Date(target).toISOString(),
    new Date(target + 6 * HOUR_MS).toISOString()
  );
  if (!row) return null;
  return (row.price - signal.price) / signal.price;
}

// 大盘基准改读物化表（迁移 023 + scripts/build-market-baseline.mjs）。
// 原来这里是每天一条相关子查询现场算，在生产库（270 万行快照）上跑不完；而基准只跟
// (日期, 窗口) 有关、跟脚本无关，三个评估脚本共用一份就行。**口径也因此统一到
// build-sell-rule-baseline.mjs 那一套**（按小时样本），跟这里原来"每个饰品每天取一条"
// 的近似口径会有小幅差异，以物化表为准。
assertBaselineTable(db);
const baselineByDay = loadBaseline(db, HORIZON_DAYS);
if (baselineByDay.size === 0) {
  console.log("market_baseline_daily 里还没有 7 天窗口的基准，先跑：node scripts/build-market-baseline.mjs");
  process.exit(0);
}
// 这份报告里每一个"超额"都是拿基准算的，所以基准是哪一版口径算的必须印在报告里——
// 半年后拿两份报告对不上时，第一件要排除的就是基准变过（迁移 024）。
console.log("");
console.log(baselineProvenance(db));

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// ---------- HOLD 的分档口径（2026-08-14 加）----------
// 为什么必须分档：HOLD 的**总体**中位数没有信息量。v2 只在 24h 涨幅 ≥15% 时表态，
// 5~15% 是**看过数据后主动放弃**的换手（回测超额只有 −3% 上下、够不着往返成本），
// <5% 则是连统计显著都没有、规则根本不打算表态的区间。绝大多数 HOLD 落在 <5%，
// 所以"HOLD 中位 +0.27%、53% 判对"约等于"没被卖掉的东西平均跟大盘一样"——
// 那是市场的性质，不是规则的判断力。**把弃权票和判断票混在一起统计，n=611 的信息量
// 跟 n=1 差不多**（这跟"SELL_STRONG 判错一笔不代表规则坏"是同一个错误的两面）。
// 真正验证了"不触发"这个决定的只有 5~15% 两档：它们的前向超额如果确实在 −3% 上下、
// 够不着成本线，那个决定就是对的；如果明显比 −6.7% 还负，说明放弃的换手其实有钱赚。
//
// 「回测同档」一列是 scripts/build-sell-rule-baseline.mjs 反推阈值时那张表的数字
// （714 个饰品 / 99 天），照抄在这里做对照——影子样本要跟它对得上才谈得上互相印证。
const BANDS = [
  { key: "down", label: "跌", min: -Infinity, max: 0, backtest: "+0.20%", verdict: "弃权" },
  { key: "0-5", label: "0~5%", min: 0, max: 0.05, backtest: "+0.15%", verdict: "弃权" },
  { key: "5-10", label: "5~10%", min: 0.05, max: 0.1, backtest: "−2.75%", verdict: "判断" },
  { key: "10-15", label: "10~15%", min: 0.1, max: 0.15, backtest: "−3.17%", verdict: "判断" },
  { key: "15-20", label: "15~20%", min: 0.15, max: 0.2, backtest: "−4.35%", verdict: "否决" },
  { key: "20-30", label: "20~30%", min: 0.2, max: 0.3, backtest: "−5.89%", verdict: "否决" },
  { key: "30+", label: ">30%", min: 0.3, max: Infinity, backtest: "−18.69%", verdict: "否决" },
];
const bandOf = (r) => BANDS.find((b) => r >= b.min && r < b.max) ?? null;
// 往返成本下界（lib/rules/cost-line.ts 的 6.7%）。分档结论要跟这条线比，不是跟 0 比。
const COST_LINE = 0.067;

// 缺基准的样本会被剔除。**剔除必须留痕到"哪一天、哪个窗口"这个粒度**：如果缺口
// 系统性地只落在某一类样本上（比如全都是最早那几天、或全都是某个窗口），剔除就从
// "少几条"变成了选择偏差，而看总数是看不出来的。
let missingBaselineDays = 0;
const missingDays = new Set();
function marketBaseline(decidedAt) {
  const day = Math.floor(Date.parse(decidedAt) / DAY_MS) * DAY_MS;
  const hit = baselineByDay.get(day);
  if (!hit) {
    missingBaselineDays += 1;
    missingDays.add(new Date(day).toISOString().slice(0, 10));
    return null;
  }
  return hit.median;
}

let pending = 0;
const scored = { SELL: [], SELL_STRONG: [], HOLD: [] };
const holdByBand = new Map(); // band.key -> { excess: number[], items: Set, pending: number }
for (const s of signals) {
  const fwd = forwardReturn(s);
  const base = fwd === null ? null : marketBaseline(s.decided_at);
  const band = s.action === "HOLD" ? bandOf(s.return_24h) : null;
  if (band) {
    if (!holdByBand.has(band.key)) holdByBand.set(band.key, { excess: [], items: new Set(), pending: 0 });
  }
  if (fwd === null || base === null) {
    pending += 1;
    if (band) holdByBand.get(band.key).pending += 1;
    continue;
  }
  scored[s.action]?.push(fwd - base);
  if (band) {
    holdByBand.get(band.key).excess.push(fwd - base);
    holdByBand.get(band.key).items.add(s.item_name);
  }
}

console.log("");
console.log("=== 命中率（未到期或缺对照基准的样本已剔除）===");
console.log(`未到期/无法评估：${pending} 条`);
if (missingBaselineDays > 0) {
  const days = [...missingDays].sort();
  console.log(
    `其中 ${missingBaselineDays} 条是**当天没有大盘基准**（窗口 ${HORIZON_DAYS} 天，物化表里缺这 ${days.length} 天：` +
      `${days.slice(0, 8).join(", ")}${days.length > 8 ? " …" : ""}）——补一下再看：node scripts/build-market-baseline.mjs`
  );
  console.log(
    "  ⚠️ 缺的日子如果集中在某一段（比如全在数据最早那几天），剔除就是选择偏差不是随机损耗，下面的数字要打折看。"
  );
}
console.log("");
console.log("动作         | 可评估 | 超额中位数 | 判对的 | 命中率");
console.log("-------------|-------|-----------|-------|-------");
const fmt = (v) => (Number.isNaN(v) ? "   -   " : (v * 100).toFixed(2).padStart(6) + "%");
for (const action of ["SELL_STRONG", "SELL", "HOLD"]) {
  const arr = scored[action];
  if (!arr.length) {
    console.log(`${action.padEnd(12)} |     0 |     -     |   -   |   -`);
    continue;
  }
  // 卖出信号判对 = 之后跑输大盘（卖了是对的）；HOLD 判对 = 之后没跑输
  const correct = action === "HOLD" ? arr.filter((v) => v >= 0).length : arr.filter((v) => v < 0).length;
  console.log(
    `${action.padEnd(12)} | ${String(arr.length).padStart(5)} | ${fmt(median(arr))} | ` +
      `${String(correct).padStart(5)} | ${((100 * correct) / arr.length).toFixed(1)}%`
  );
}

// ---------- HOLD 分档 ----------
console.log("");
console.log("=== HOLD 分档（按决策当时的 24h 涨幅）===");
console.log("HOLD 总体那一行不要读——它绝大部分是 v2 根本不打算表态的弃权票，中位为正是市场的");
console.log("性质不是规则的判断力。只看「判断」那两档：那才是看过数据后主动放弃的换手。");
console.log("");
console.log("涨幅档   | 性质 | 可评估 | 超额中位数 | 为负占比 | 饰品数 | 回测同档 | 未到期/缺基准");
console.log("---------|------|-------|-----------|---------|-------|---------|------------");
for (const band of BANDS) {
  const hit = holdByBand.get(band.key);
  if (!hit || (!hit.excess.length && !hit.pending)) continue;
  const arr = hit.excess;
  const negShare = arr.length ? `${((100 * arr.filter((v) => v < 0).length) / arr.length).toFixed(1)}%` : "-";
  console.log(
    `${band.label.padEnd(8)} | ${band.verdict} | ${String(arr.length).padStart(5)} | ${fmt(median(arr))} | ` +
      `${negShare.padStart(7)} | ${String(hit.items.size).padStart(5)} | ${band.backtest.padStart(7)} | ${hit.pending}`
  );
}

// 「判断」两档合起来才是这次真正要看的东西，单独再报一行，免得被上面六行淹没。
const decisive = ["5-10", "10-15"].flatMap((k) => holdByBand.get(k)?.excess ?? []);
const decisiveItems = new Set(["5-10", "10-15"].flatMap((k) => [...(holdByBand.get(k)?.items ?? [])]));
console.log("");
if (decisive.length) {
  const m = median(decisive);
  console.log(
    `5~15% 合计（"明确不触发"那一段）：${decisive.length} 条可评估、涉及 ${decisiveItems.size} 个饰品、` +
      `超额中位数 ${(m * 100).toFixed(2)}%、为负占比 ${((100 * decisive.filter((v) => v < 0).length) / decisive.length).toFixed(1)}%`
  );
  console.log(
    `  对照：回测同段是 −2.75% / −3.17%，往返成本下界 ${(COST_LINE * 100).toFixed(1)}%。` +
      `幅度够不着成本线 ⇒ 放弃这批换手是对的；` +
      `明显负过 −${(COST_LINE * 100).toFixed(1)}% ⇒ 那个决定要重看。`
  );
  if (decisive.length < 30 || decisiveItems.size < 10) {
    console.log("  ⚠️ 样本不够，上面这两个数字现在只能看方向，不能当结论（判据：可评估 ≥30 条且 ≥10 个饰品）。");
  }
} else {
  console.log('5~15%（"明确不触发"那一段）：0 条可评估——这次没有任何主动放弃的换手到期，本节无结论。');
}
const vetoed = ["15-20", "20-30", "30+"].flatMap((k) => holdByBand.get(k)?.excess ?? []);
if (vetoed.length) {
  console.log(
    `≥15% 却仍 HOLD（只可能来自洗盘否决）：${vetoed.length} 条、超额中位数 ${(median(vetoed) * 100).toFixed(2)}%` +
      "——这批是否决条款自己的成绩单，跟上面那段分开算。"
  );
}

console.log("");
console.log("读法：卖出类的\"命中率\"就是 1 − 假信号率。要替换 v1，至少得看到卖出类命中率明显过半、");
console.log("     且超额中位数是负的（说明卖在了相对高点），同时**5~15% 那两档 HOLD** 没有系统性判反");
console.log("     （不是看 HOLD 总体那一行，理由见上面 BANDS 那段注释）。");
console.log("     样本量太小时这些数字没有意义——回测里 15~20% 档的为负占比也才 61%，");
console.log("     几十条样本的波动完全能盖过这个幅度，至少要攒到三位数再下结论。");
