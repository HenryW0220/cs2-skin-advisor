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
//
// ⚠️ **但缺基准有两类，混在一起打等于把告警埋进噪音**（2026-08-14 教训：第一版只报一个
// 总数，从 9 条涨到 135 条看着像故障，其实绝大部分是结构性的）：
//   (a) **未成熟**——D 日的 N 天窗口本来就要到 D+N（再加 6 小时定型）才可能算得出来，
//       所以**报告永远缺最近 N 天，这不是缺口是成熟度的形状**，排什么定时任务都消除不了，
//       判读时本来就该扣掉；
//   (b) **已成熟但基准缺失**——窗口早就到期了却查不到，说明 builder 没跑或跑漏了。
//       **只有这一类是真告警。**
// 分开打之后，(b) 出现一条就该红，不会再被 (a) 的几百条淹掉。
const SETTLE_MS = 6 * HOUR_MS; // 跟 market-baseline-store.mjs 的 SETTLE_MS 一致
let missingImmature = 0; // (a) 窗口还没到期
let missingSettled = 0; // (b) 已成熟却查不到 —— 这个才是告警
const missingSettledDays = new Set();
function marketBaseline(decidedAt) {
  const dayMs = Math.floor(Date.parse(decidedAt) / DAY_MS) * DAY_MS;
  const hit = baselineByDay.get(dayMs);
  if (!hit) {
    // ⚠️ **判定型必须用当天的最后一小时，不是 00:00**（2026-08-16 修）。
    // 物化表口径是 `dayCompleteness: whole-day-only`——**一天要整天都定型了才写**
    // （market-baseline-store.mjs 里 `lastHourMs + horizon*DAY + SETTLE > cutoff`）。
    // 而这里原来用 `dayMs`（当天 00:00）判，于是 **D 日的基准还差最后一小时没定型时，
    // 落在 D 日的信号会被判成「已成熟却查不到 ⇒ 真缺口 ⇒ builder 没跑」**。
    //
    // **这个误判不只是标签错了，它指挥人做了一次无效操作**：2026-08-16 照着它的提示跑了
    // 一轮 builder，builder 正确地回答"没有已定型且缺失的日子，无事可做"（114.6 秒）。
    // 根因是**两个"成熟"不是同一件事**：一条 D 日的**信号**在 D+7 到期，而 D 日**那一天的
    // 基准**要等当天最后一小时也走完 D+7+6h——**所以永远存在约一天的窗口，信号熟了、
    // 它那天的基准还没熟**。那是形状不是缺口。
    //
    // 这一处本身又是"两边各写一份定义"（HANDOFF 第四节 0.5）：定型规则在 store 里有一份、
    // 这里重写了一份，而 store 那份在 b9645fa10 → b03672dc0 升版时改了，这份没跟上。
    const lastHourMs = dayMs + DAY_MS - HOUR_MS;
    if (lastHourMs + HORIZON_DAYS * DAY_MS + SETTLE_MS > Date.now()) missingImmature += 1;
    else {
      missingSettled += 1;
      missingSettledDays.add(new Date(dayMs).toISOString().slice(0, 10));
    }
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
if (missingImmature > 0) {
  console.log(
    `  · 其中 ${missingImmature} 条是**基准还没成熟**（决策日 + ${HORIZON_DAYS} 天窗口尚未定型）——` +
      `**预期内，不是缺口**：报告永远缺最近 ${HORIZON_DAYS} 天，这是成熟度的形状，排定时任务也消除不了。`
  );
}
if (missingSettled > 0) {
  const days = [...missingSettledDays].sort();
  console.log(
    `  · ⚠️ **另有 ${missingSettled} 条是已成熟却查不到基准**（缺这 ${days.length} 天：` +
      `${days.slice(0, 8).join(", ")}${days.length > 8 ? " …" : ""}）。**这一类才是真缺口**，` +
      `说明 builder 没跑或跑漏了：node scripts/build-market-baseline.mjs ${HORIZON_DAYS}`
  );
  console.log(
    "    缺的日子如果集中在某一段，剔除就是选择偏差不是随机损耗，下面的数字要打折看。"
  );
} else {
  console.log("  · 已成熟但缺基准：0 条（这一类是真告警，0 才是正常）。");
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

// ============================================================================
// 注意力面板：哪一格在长、每一格离自己的门槛还差多少
// ============================================================================
// **为什么固定输出这个（2026-08-16）**：观察期判据一直挂在错误的位置上。
// HANDOFF 定的是"攒到三位数卖出信号再下结论"，而那个三位数指的是 **SELL 类**；
// 实际情况是 SELL 12 条、SELL_STRONG 1 条，而 **HOLD 5~15% 段已经 60 条**——
// **照现在的速度 SELL 攒到三位数要几个月，而那期间真正在积累证据的那一格没有任何判据在盯着。**
//
// 这跟 2026-08-16 归因查出来的形状是同一个：**问题不是数据不够，是没人在看那一格。**
// 所以让报告自己指出注意力该放哪，不用人去翻。
const NOW = Date.now();
const WEEK_MS = 7 * DAY_MS;
const cells = [
  ...BANDS.map((b) => ({
    name: `HOLD ${b.label}`,
    verdict: b.verdict,
    match: (s) => s.action === "HOLD" && bandOf(s.return_24h)?.key === b.key,
  })),
  { name: "SELL", verdict: "卖出", match: (s) => s.action === "SELL" },
  { name: "SELL_STRONG", verdict: "卖出", match: (s) => s.action === "SELL_STRONG" },
];
// 门槛跟上面那条判据一致：可评估 ≥30 条且 ≥10 个饰品
const GATE_EVAL = 30;
const GATE_ITEMS = 10;

console.log("");
console.log("=== 注意力面板：哪一格在长、离门槛还差多少 ===");
console.log("**判据挂错位置是个真实风险**：我们盯着 SELL 类攒三位数，而证据其实长在 HOLD 的判断档里。");
console.log("");
console.log("⚠️ **这是注意力工具，不是决策工具。「已过门槛」≠「可行动」**——门槛只管样本量，");
console.log("   可行动要看幅度对 6.7% 的成本线，那是另一条判据。现成的反例就在下面：");
console.log("   `HOLD 5~10%` 已过门槛，但归因实测 −5.84%，**贴近但够不着**成本线");
console.log("   （REPORT-hold-5to15-attribution.md）。看到「已过门槛」就动手是错的。");
console.log("");
console.log("格子             | 性质 | 累计 | 可评估 | 饰品 | 近 7 天 | 前 7 天 | 增速   | 离门槛还差");
console.log("-----------------|------|------|--------|------|---------|---------|--------|----------");
const panel = [];
for (const c of cells) {
  const mine = signals.filter(c.match);
  if (!mine.length) continue;
  const recent = mine.filter((s) => NOW - Date.parse(s.decided_at) < WEEK_MS).length;
  const prior = mine.filter((s) => {
    const age = NOW - Date.parse(s.decided_at);
    return age >= WEEK_MS && age < 2 * WEEK_MS;
  }).length;
  // 可评估数和饰品数直接复用上面算好的，避免第二份口径
  let evalN = 0;
  let itemN = 0;
  if (c.name.startsWith("HOLD ")) {
    const key = BANDS.find((b) => `HOLD ${b.label}` === c.name)?.key;
    const hit = holdByBand.get(key);
    evalN = hit?.excess.length ?? 0;
    itemN = hit?.items.size ?? 0;
  } else {
    evalN = scored[c.name]?.length ?? 0;
    itemN = new Set(mine.map((s) => s.item_name)).size;
  }
  const need = [];
  if (evalN < GATE_EVAL) need.push(`${GATE_EVAL - evalN} 条`);
  if (itemN < GATE_ITEMS) need.push(`${GATE_ITEMS - itemN} 品`);
  const growth = prior === 0 ? (recent > 0 ? "新增" : "—") : `${(recent / prior).toFixed(2)}×`;
  panel.push({ name: c.name, verdict: c.verdict, recent, evalN, itemN, passed: !need.length });
  console.log(
    `${c.name.padEnd(16)} | ${c.verdict.padEnd(4)} | ${String(mine.length).padStart(4)} | ` +
      `${String(evalN).padStart(6)} | ${String(itemN).padStart(4)} | ${String(recent).padStart(7)} | ` +
      `${String(prior).padStart(7)} | ${growth.padStart(6)} | ${need.length ? "还差 " + need.join(" + ") : "**已过门槛**"}`
  );
}
console.log("");
{
  // **排名要排除弃权格**：HOLD 的"跌"和"0~5%"是 v2 根本不打算表态的区间，
  // 它们永远是增长最快的（占了全部信号的 95%），但 HANDOFF ⑩ 已经确认
  // **那 600 条弃权票的信息量跟 n=1 没差多少**——把它们排进来，这块面板每轮都会
  // 指向同一个没有信息的地方，等于没有面板。只在"判断/卖出"这些**规则真的表了态**的格子里排。
  const informative = panel.filter((p) => p.verdict !== "弃权");
  const fastest = [...informative].sort((a, b) => b.recent - a.recent)[0];
  const passed = informative.filter((p) => p.passed).map((p) => p.name);
  if (fastest) {
    console.log(
      `**近 7 天新增最多的「有表态」格子：${fastest.name}（${fastest.recent} 条）** ← 注意力该放这里。`
    );
    console.log("（弃权格「跌」「0~5%」不参与排名：它们占了全部信号的绝大多数，但那是 v2 不表态的区间，");
    console.log("  信息量跟 n=1 没差多少（HANDOFF ⑩）。排进来的话这块面板每轮都指向同一个没信息的地方。）");
  }
  console.log(
    passed.length
      ? `**有表态且已过门槛的格子：${passed.join("、")}** —— 这些格子的数字可以当结论读（仍要看幅度对成本线）。`
      : "**目前没有任何「有表态」的格子过门槛**，所有数字都只能看方向。"
  );
  console.log("⚠️ 过门槛只说明「样本够了」，**不说明够得着成本线**——那是另一条判据，别混。");
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
