// 只量不修：build-rsi-trend-baseline.mjs 的**自算基准** vs **物化表基准**，差多少。
// 用法：node scripts/compare-rsi-baseline-caliber.mjs [库文件]
//
// **这个脚本不改任何已发布的数字，也不碰 build-rsi-trend-baseline.mjs。**
//
// ============================================================================
// 为什么要先量再修（2026-08-15 项目所有者定的顺序）
// ============================================================================
// `build-rsi-trend-baseline.mjs` 的抬头曾写着"与 build-sell-rule-baseline.mjs 口径完全一致"，
// 8-15 查出这句已经失效：8-13 之后 sell-rule 改读物化表，而它至今自己算，两处分岔——
//   ① 物化表有 `dayCompleteness=whole-day-only` + `settleHours=6`（整天定型才算），
//      自算版**没有任何定型逻辑**，边界日会用半天数据参与；
//   ② 偶数样本的中位数：物化表 `mean-of-two-middles`，自算版 `s[floor(n/2)]`。
//
// 它的数字直接写进 `lib/rules/cost-line.ts` 的 SIGNAL_EVIDENCE，在页面和 LLM 提示词里
// 驱动"不可行动"标注——**也就是说它正在影响项目所有者实际看到的建议**。
//
// **但不能直接改成读物化表**：那会**同时**改变数字和口径，事后就分不清"数字变了多少是
// 因为口径"。先量一次，是把这两件事拆开的**唯一机会**。
//
// ============================================================================
// 怎么量：不需要重算 RSI，一个恒等式就够
// ============================================================================
// 对同一个样本：
//     超额_自算 = fwd − base_自算(当天)
//     超额_物化 = fwd − base_物化(当天)
//   ⇒ 超额_物化 − 超额_自算 = **base_自算(当天) − base_物化(当天)** ≡ Δ(当天)
//
// 也就是说**换口径对每个样本的影响，完全由"那一天两个基准差多少"决定，跟 RSI 档位无关**。
// 而中位数在有界平移下也有界：若某档全部样本的 Δ ∈ [lo, hi]，则该档超额中位数的移动
// 也必然 ∈ [lo, hi]。**所以只要报出 Δ 的分布和极值，就得到了所有档位移动的严格上界**，
// 一行 RSI 都不用重算。
//
// ⚠️ 这个上界**只覆盖"两边都有基准的天"**。两边覆盖范围不同导致的样本增删是另一回事，
// 单独报（见输出第三节）——那部分不是平移，是换样本集合。
import Database from "better-sqlite3";
import { assertBaselineTable, baselineProvenance, loadBaseline } from "./market-baseline-store.mjs";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "compare-rsi-baseline-caliber",
  usage: "node scripts/compare-rsi-baseline-caliber.mjs [库文件]",
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const db = new Database(resolveDbPath(args.dbPath), { readonly: true });

const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
// 下面四个常量逐字抄自 build-rsi-trend-baseline.mjs，**不要"顺手统一"**——
// 这个脚本的全部意义就是复刻它现在的行为，改了就量不出差异了。
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const HORIZON_DAYS = 7;
const MIN_ROWS = 200;
const MIN_MARKET_SAMPLES = 20;

/** 自算版的中位数：奇偶都取 s[floor(n/2)]（这正是分岔点②） */
const medianInline = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pp = (v) => (Number.isNaN(v) ? "   -   " : (v * 100).toFixed(3).padStart(7) + "pp");

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

assertBaselineTable(db);
console.log(baselineProvenance(db));
console.log("");

// ---------- 第一遍：完全复刻 build-rsi-trend-baseline.mjs 的自算基准 ----------
const items = db.prepare("SELECT DISTINCT item_name FROM price_snapshots").all().map((r) => r.item_name);
const fwdByDay = new Map();
// 每天有多少个样本，用来判断这一天在自算版里是"整天"还是"半天"（分岔点①的可观测代理）
let usable = 0;
for (const item of items) {
  const platform = referencePlatform(item);
  if (!platform) continue;
  const series = hourlyPrices(item, platform);
  if (series.length < 24 * (HORIZON_DAYS + 14)) continue;
  usable += 1;
  const hourIndex = new Map(series.map(([h], i) => [h, i]));
  for (let i = 48; i < series.length; i++) {
    const [ts, price] = series[i];
    const futureIdx = hourIndex.get(ts + HORIZON_DAYS * DAY_MS);
    if (futureIdx === undefined) continue;
    const day = Math.floor(ts / DAY_MS) * DAY_MS;
    if (!fwdByDay.has(day)) fwdByDay.set(day, []);
    fwdByDay.get(day).push((series[futureIdx][1] - price) / price);
  }
}

const inlineByDay = new Map();
const inlineCount = new Map();
for (const [d, arr] of fwdByDay) {
  if (arr.length >= MIN_MARKET_SAMPLES) {
    inlineByDay.set(d, medianInline(arr));
    inlineCount.set(d, arr.length);
  }
}
fwdByDay.clear();

const matByDay = loadBaseline(db, HORIZON_DAYS);

console.log(`参与统计的饰品：${usable} 个`);
console.log(`自算基准覆盖 ${inlineByDay.size} 天；物化表基准覆盖 ${matByDay.size} 天`);
console.log("");

// ---------- 第二节：两边都有基准的天，Δ 的分布 ----------
const deltas = [];
const perDay = [];
for (const [day, inline] of inlineByDay) {
  const mat = matByDay.get(day);
  if (mat === undefined) continue;
  const d = inline - mat.median;
  deltas.push(d);
  perDay.push({ day, inline, mat: mat.median, d, nInline: inlineCount.get(day), nMat: mat.sampleCount });
}
deltas.sort((a, b) => a - b);

console.log("=== ① 共同覆盖的天：Δ = 自算基准 − 物化基准 ===");
console.log(`共同覆盖 ${deltas.length} 天`);
if (deltas.length) {
  const absMax = Math.max(...deltas.map(Math.abs));
  const nonZero = deltas.filter((d) => Math.abs(d) > 1e-9).length;
  console.log(`  完全相同的天：${deltas.length - nonZero} / ${deltas.length}`);
  console.log(`  Δ 中位数 ${pp(median(deltas))}｜p5 ${pp(deltas[Math.floor(deltas.length * 0.05)])}｜p95 ${pp(deltas[Math.floor(deltas.length * 0.95)])}`);
  console.log(`  **|Δ| 最大值 ${pp(absMax)}** ← 这就是所有档位超额中位数移动的**严格上界**`);
  console.log("");
  console.log("  差异最大的 8 天（看 n 那两列：自算版把没定型的整天也算了，样本数会明显偏少）：");
  console.log("  日期       |   自算基准 |   物化基准 |        Δ | 自算样本数 | 物化样本数");
  console.log("  -----------|-----------|-----------|----------|-----------|----------");
  for (const r of [...perDay].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 8)) {
    console.log(
      `  ${new Date(r.day).toISOString().slice(0, 10)} | ${(r.inline * 100).toFixed(2).padStart(8)}% | ` +
        `${(r.mat * 100).toFixed(2).padStart(8)}% | ${pp(r.d)} | ${String(r.nInline).padStart(9)} | ${String(r.nMat).padStart(8)}`
    );
  }
}
console.log("");

// ---------- 第三节：覆盖差异（这部分不是平移，上界管不着） ----------
const onlyInline = [...inlineByDay.keys()].filter((d) => !matByDay.has(d)).sort();
const onlyMat = [...matByDay.keys()].filter((d) => !inlineByDay.has(d)).sort();
console.log("=== ② 覆盖差异：换口径会增删哪些天的样本 ===");
console.log("**这部分不是平移，第①节那个上界管不着它**——换的是样本集合本身。");
const fmtDays = (a) =>
  a.length ? a.slice(0, 8).map((d) => new Date(d).toISOString().slice(0, 10)).join("、") + (a.length > 8 ? ` 等 ${a.length} 天` : "") : "（无）";
console.log(`  只有自算版有的天：${onlyInline.length} 天 —— ${fmtDays(onlyInline)}`);
console.log(`    ↑ 改成读物化表之后，这些天的样本会**整体消失**`);
console.log(`  只有物化表有的天：${onlyMat.length} 天 —— ${fmtDays(onlyMat)}`);
console.log(`    ↑ 改成读物化表之后，这些天的样本会**新进来**`);
console.log("");

// ---------- 判读 ----------
console.log("=== 怎么判 ===");
if (deltas.length) {
  const absMax = Math.max(...deltas.map(Math.abs));
  console.log(`共同覆盖的天上，任何一档超额中位数的移动都不会超过 **${(absMax * 100).toFixed(3)}pp**。`);
  console.log("对照：cost-line.ts 里 SIGNAL_EVIDENCE 的数字是 RSI 超买 −0.96% / 超卖 +0.61%（小时口径），");
  console.log("而判据是 6.7% 的往返成本线——**两者相距一个数量级**。");
  console.log("");
  console.log("· 上界远小于各档与成本线的距离 ⇒ **结论稳健**，可以改成读物化表，改完数字会小幅变动，");
  console.log("  但变动幅度已知、不构成结论变更。把这个实测数字写进 HANDOFF 再改。");
  console.log("· 上界大到能让任何一档跨过成本线 ⇒ **那是结论变更**，SIGNAL_EVIDENCE 和「不可行动」");
  console.log("  标注都要重新审，单独处理，不要顺手改。");
  console.log("");
  console.log("⚠️ 第②节的覆盖差异要单独看：它增删的是整天的样本，不受上界约束。天数少就无所谓，");
  console.log("   天数多的话得单独估——但注意那多半是成熟度前沿（最新几天还没定型），是形状不是缺口。");
}
