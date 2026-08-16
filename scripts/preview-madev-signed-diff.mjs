// A3：把嫌疑分里的 maDev 从**绝对值**改成**带符号**，会改变哪些饰品的分数和 ≥60 触发集合。
// 用法：node scripts/preview-madev-signed-diff.mjs [库文件]
//
// **只读脚本。不改阈值、不改权重、不上线。只出一份 diff 清单。**
//
// ============================================================================
// 为什么这一条被从审计清单里提前（2026-08-15 项目所有者决定）
// ============================================================================
// HYPOTHESES §2.4b 列了 6 条"只有排序证据、从没量过幅度"的结论，原则是**只列不跑**。
// **A3 有本质区别：其余五条是"没量过"，A3 是"已经有反证在手"。**
//
// `lib/signals/manipulation-score.ts` 里 maDev 是**绝对值**：
//     maDeviation = |price − ma168| / ma168
// 而 2026-08-15 的买入侧分档表（REPORT-t7-entry-conditions.md）实测**带符号之后两侧
// 完全不对称**：
//     maDev > +20%  →  T+7 绝对收益中位 **−19.04%**（够得着 12% 成本线的强卖出信号）
//     maDev < −20%  →  T+7 绝对收益中位 **+4.57%**（够不着 6.7%，弱买入信号）
// **取绝对值等于把这两个折叠进同一档。**这不是"可能有问题"，是**已知的信息损失**。
//
// 而且它的风险面是活的：嫌疑分 ≥60 会触发 Web Push，而推送链路 8-14 刚验通、订阅刚恢复。
// **也就是说从现在起这个缺陷会开始真的推东西给人。**
//
// ============================================================================
// 预先声明：只看一件事
// ============================================================================
// **嫌疑分的排序、以及 ≥60 触发集合变化多大。**
//   · 哪些饰品会掉出 ≥60（现在会推、改完不推）
//   · 哪些会进来（现在不推、改完会推）
// **不评估"哪个更准"**——那需要前瞻收益，是另一次检验、要另外声明。
// 这一份只回答"改动的影响面有多大"，供项目所有者决定改不改。
//
// 先验预期（写在跑之前，免得事后合理化）：项目所有者的判断是"嫌疑分本来就该只对正向
// 偏离敏感"。若如此，掉出 ≥60 的应当**主要是深跌品**（负偏离被绝对值算成了高分），
// 而进来的应当很少甚至没有（带符号只会让分数**变小或不变**，见下）。
//
// ⚠️ **一个必然的性质，先说清楚免得误读**：ramp() 是单调递增且下界截断在 0 的，
// 把 |x| 换成 x 只会让 maDev 那一项的贡献**变小或不变**（负偏离从正贡献变成 0）。
// 所以**理论上不可能有饰品"进来"**。如果实际跑出来有，那说明我复刻的算分逻辑跟生产
// 不一致——**那本身就是要查的东西**，所以这一列照样打印出来，当自检用。
import Database from "better-sqlite3";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "preview-madev-signed-diff",
  usage: "node scripts/preview-madev-signed-diff.mjs [库文件]",
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const db = new Database(resolveDbPath(args.dbPath), { readonly: true });

const HOUR_MS = 36e5;
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const HIGH_THRESHOLD = 60; // lib/signals/manipulation-score.ts 的 level==="high"
const MIN_HISTORY = 192; // 同上：数据不足 192 个小时点返回 null

// ---- 以下三个 ramp 区间逐字抄自 lib/signals/manipulation-score.ts，不要改 ----
// 抄而不是 import：那边是 .ts，这边是 .mjs，跨不过去。**这正是 HANDOFF 第四节 0.5
// 「生产与回测必须共用同一份定义」那条待办要解决的问题**——这个脚本本身就是又一个例子。
// 所以下面加了一条自检：用当前口径复刻出来的 high 集合，必须跟库里 item_signal_summaries
// 存的对得上，对不上就说明抄漏了，直接报错退出。
const ramp = (x, lo, hi) => Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
function scoreFrom(vol24h, move24h, maDev) {
  return Math.round(100 * (0.45 * ramp(vol24h, 0.0064, 0.031) + 0.3 * ramp(move24h, 0.019, 0.094) + 0.25 * ramp(maDev, 0.032, 0.11)));
}

function referencePlatform(itemName) {
  const rows = db
    .prepare(
      `SELECT platform, COUNT(*) n FROM price_snapshots
       WHERE item_name = ? AND platform IS NOT NULL AND price > 0
       GROUP BY platform ORDER BY n DESC`
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
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

/** 逐行复刻 computeManipulationScore，只是同时返回绝对值版和带符号版。 */
function bothScores(prices) {
  const n = prices.length;
  if (n < MIN_HISTORY) return null;
  const returns = [];
  for (let i = 1; i < n; i++) if (prices[i - 1] > 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  if (returns.length < 24) return null;

  const last24 = returns.slice(-24);
  const volatility24h = Math.sqrt(last24.reduce((s, r) => s + r * r, 0) / last24.length);
  const prev24Price = prices[n - 25];
  const move24h = prev24Price > 0 ? Math.abs(prices[n - 1] - prev24Price) / prev24Price : 0;
  const window168 = prices.slice(-169, -1);
  const ma168 = window168.reduce((s, p) => s + p, 0) / window168.length;

  const devSigned = ma168 > 0 ? (prices[n - 1] - ma168) / ma168 : 0;
  const devAbs = Math.abs(devSigned);
  // 带符号版：负偏离（低于均线）不该被当成"像在操盘"，ramp 的下界截断天然把它压成 0
  return {
    scoreAbs: scoreFrom(volatility24h, move24h, devAbs),
    scoreSigned: scoreFrom(volatility24h, move24h, devSigned),
    devSigned,
    volatility24h,
    move24h,
  };
}

// ---------- 跑 ----------
const items = db
  .prepare("SELECT DISTINCT item_name FROM price_snapshots WHERE price > 0")
  .all()
  .map((r) => r.item_name);

const rows = [];
for (const item of items) {
  const platform = referencePlatform(item);
  if (!platform) continue;
  const prices = hourlyPrices(item, platform);
  const s = bothScores(prices);
  if (!s) continue;
  rows.push({ item, platform, ...s });
}

console.log("");
console.log(`可算分的饰品：${rows.length} 个（历史 ≥${MIN_HISTORY} 小时点）`);
console.log("");

const highAbs = rows.filter((r) => r.scoreAbs >= HIGH_THRESHOLD);
const highSigned = rows.filter((r) => r.scoreSigned >= HIGH_THRESHOLD);
const dropOut = rows.filter((r) => r.scoreAbs >= HIGH_THRESHOLD && r.scoreSigned < HIGH_THRESHOLD);
const comeIn = rows.filter((r) => r.scoreAbs < HIGH_THRESHOLD && r.scoreSigned >= HIGH_THRESHOLD);
const changed = rows.filter((r) => r.scoreAbs !== r.scoreSigned);

console.log("=== ≥60 触发集合的变化（这是唯一要看的东西）===");
console.log(`绝对值版（现在线上跑的）：${highAbs.length} 个`);
console.log(`带符号版（假如改掉）：    ${highSigned.length} 个`);
console.log(`  掉出 ≥60（现在会推、改完不推）：${dropOut.length} 个`);
console.log(`  进入 ≥60（现在不推、改完会推）：${comeIn.length} 个`);
if (comeIn.length) {
  console.log("  ⚠️ **进来的不该存在**：ramp 单调且下界截断在 0，带符号只会让分数变小或不变。");
  console.log("     出现这一列说明本脚本复刻的算分逻辑跟生产不一致，先查这个，别看下面的结论。");
}
console.log(`分数发生变化的饰品：${changed.length} 个（占可算分的 ${((100 * changed.length) / rows.length).toFixed(1)}%）`);
console.log("");

// ---------- 自检：复刻的算分必须跟**生产真的算出来过的**对得上 ----------
// 不做这一步，"掉出 10 个"这个数字可能只是我抄错 ramp 区间的产物。
//
// 嫌疑分**没有被持久化**（`item_signal_summaries` 只存规则引擎的 score，嫌疑分是每次
// 现算的），所以没有"当前分"可比。**但 `anomaly_events` 里 192 条 metric='manipulation_score'
// 的 `value` 就是生产在 `detected_at` 那一刻算出来的分。**
// 把序列截断到 detected_at 再用本脚本的绝对值版重算，应当对得上——这是一次真正的
// **生产 vs 脚本等价性验证**，而不是拿脚本自己验自己。
//
// ⚠️ 不要求 100% 逐位相同：生产当时用的历史窗口受 SIGNAL_HISTORY_WINDOW_DAYS（21 天）
// 截断，而且快照在那之后可能有补写。**要看的是绝大多数能对上**；大面积对不上说明复刻错了，
// 上面的 diff 就一个字都不能信。
const events = db
  .prepare(
    `SELECT item_name, platform, value, detected_at FROM anomaly_events
     WHERE metric = 'manipulation_score' AND value IS NOT NULL`
  )
  .all();
console.log("=== 自检：本脚本的绝对值版 vs 生产在 anomaly_events 里留下的分 ===");
if (events.length) {
  const seriesCache = new Map();
  let compared = 0;
  let exact = 0;
  let within2 = 0;
  const worst = [];
  for (const e of events) {
    const cacheKey = `${e.item_name}|${e.platform}`;
    if (!seriesCache.has(cacheKey)) {
      seriesCache.set(
        cacheKey,
        db
          .prepare(
            `SELECT captured_at, price FROM price_snapshots
             WHERE item_name = ? AND platform = ? AND price > 0 ORDER BY captured_at ASC`
          )
          .all(e.item_name, e.platform)
      );
    }
    const cutoff = Date.parse(e.detected_at);
    const byHour = new Map();
    for (const r of seriesCache.get(cacheKey)) {
      const t = Date.parse(r.captured_at);
      if (t > cutoff) break;
      byHour.set(Math.floor(t / HOUR_MS) * HOUR_MS, r.price);
    }
    const prices = [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
    const s = bothScores(prices);
    if (!s) continue;
    compared += 1;
    const d = Math.abs(s.scoreAbs - e.value);
    if (d === 0) exact += 1;
    if (d <= 2) within2 += 1;
    else worst.push({ item: e.item_name, mine: s.scoreAbs, stored: e.value, d, at: e.detected_at });
  }
  const pct = (x) => ((100 * x) / compared).toFixed(1);
  console.log(
    `可比对 ${compared} / ${events.length} 条事件：逐位相同 ${exact} 条（${pct(exact)}%）、` +
      `差 ≤2 分 ${within2} 条（${pct(within2)}%）`
  );
  if (within2 / compared < 0.8) {
    console.log("  ✗✗ **对不上的太多，本脚本的复刻不可信，上面的 diff 作废。** 先查 ramp 区间和窗口口径。");
  } else {
    console.log("  ✓ 绝大多数对得上，复刻可信。");
  }
  if (worst.length) {
    console.log(`  差 >2 分的 ${worst.length} 条，最大的几条：`);
    for (const w of worst.sort((a, b) => b.d - a.d).slice(0, 5)) {
      console.log(`    ${w.item}（${w.at.slice(0, 16)}）：本脚本 ${w.mine} / 生产 ${w.stored}（差 ${w.d}）`);
    }
  }
} else {
  console.log("库里没有 manipulation_score 事件，**自检没做成——上面的 diff 只能当参考**。");
}
console.log("");

// ---------- 清单 ----------
if (dropOut.length) {
  console.log("=== 掉出 ≥60 的饰品（按原分数降序）===");
  console.log("这些是**改完就不会再推的**。看 devSigned 那一列：负数 = 价格在均线**之下**，");
  console.log("也就是被绝对值算成了「像在操盘」的深跌品。");
  console.log("");
  console.log("饰品                                               | 绝对值分 | 带符号分 | 偏离均线 | 24h波动 | 24h涨跌");
  console.log("---------------------------------------------------|---------|---------|---------|---------|--------");
  for (const r of dropOut.sort((a, b) => b.scoreAbs - a.scoreAbs)) {
    console.log(
      `${r.item.slice(0, 50).padEnd(50)} | ${String(r.scoreAbs).padStart(7)} | ${String(r.scoreSigned).padStart(7)} | ` +
        `${(r.devSigned * 100).toFixed(2).padStart(7)}% | ${(r.volatility24h * 100).toFixed(2).padStart(6)}% | ${(r.move24h * 100).toFixed(2).padStart(6)}%`
    );
  }
  console.log("");
  const negDev = dropOut.filter((r) => r.devSigned < 0).length;
  console.log(
    `掉出的 ${dropOut.length} 个里，${negDev} 个（${((100 * negDev) / dropOut.length).toFixed(0)}%）确实是负偏离（价格低于均线）。` +
      `${negDev === dropOut.length ? "**全部**如此，跟先验一致。" : "**有例外，值得看一眼为什么。**"}`
  );
  // ⚠️ 这一行是跑完之后才发现的形状，但它可能推翻"带符号显然更对"这个先验，所以必须打出来
  const rebound = dropOut.filter((r) => r.devSigned < 0 && r.move24h > 0.03).length;
  if (rebound) {
    console.log("");
    console.log(
      `⚠️ **但注意：掉出的这批里有 ${rebound} 个是「24h 涨幅 >3% 且仍在均线之下」——也就是深跌后正在反抽。**`
    );
    console.log("   这个形态**恰好是操盘剧本第 4 阶段（洗盘/砸盘接急拉）**，见");
    console.log("   REPORT-manipulation-playbook-stages.md 和 lib/signals/washout.ts。");
    console.log("   **所以「负偏离 = 不该报」这个先验未必成立**：砸盘也是操盘，嫌疑分问的是");
    console.log("   「当前是否处于操盘期」而不是「买了会不会赚」。改成带符号会把洗盘态整体静音。");
    console.log("   **这一条足以让「显然该改」变成「要拍板」——请连着上面的清单一起看。**");
  }
}
console.log("");
console.log("=== 这份输出不能证明什么 ===");
console.log("· 它只说明**影响面有多大**，不说明改完更准——那要看前瞻收益，是另一次检验。");
console.log("· 分数变化的饰品占比高不代表该改，占比低也不代表不该改：**看的是掉出的那批是不是");
console.log("  本来就不该被推的深跌品**，那是判断题不是统计题，得人看清单。");
console.log("· 嫌疑分回答的是「当前是否处于操盘期」，**不是**「买了会不会赚」。深跌品被判成");
console.log("  高嫌疑分未必是错的（砸盘也是操盘），所以这份清单要项目所有者按业务判断，不能自动化。");
