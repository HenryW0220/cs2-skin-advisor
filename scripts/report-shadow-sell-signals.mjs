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
import Database from "better-sqlite3";

const db = new Database("data/db.sqlite", { readonly: true });
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

// 大盘基准：当天全部饰品未来 7 天收益的中位数（口径跟 build-sell-rule-baseline.mjs 一致）
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

const marketCache = new Map();
function marketBaseline(decidedAt) {
  const day = Math.floor(Date.parse(decidedAt) / DAY_MS) * DAY_MS;
  if (marketCache.has(day)) return marketCache.get(day);
  const rows = db
    .prepare(
      `SELECT a.item_name, a.platform, a.price p0, (
         SELECT b.price FROM price_snapshots b
         WHERE b.item_name = a.item_name AND b.platform = a.platform AND b.price > 0
           AND b.captured_at >= ? AND b.captured_at < ?
         ORDER BY b.captured_at ASC LIMIT 1
       ) p1
       FROM price_snapshots a
       WHERE a.captured_at >= ? AND a.captured_at < ? AND a.price > 0
       GROUP BY a.item_name, a.platform`
    )
    .all(
      new Date(day + HORIZON_DAYS * DAY_MS).toISOString(),
      new Date(day + HORIZON_DAYS * DAY_MS + 6 * HOUR_MS).toISOString(),
      new Date(day).toISOString(),
      new Date(day + DAY_MS).toISOString()
    );
  const rets = rows.filter((r) => r.p1 > 0 && r.p0 > 0).map((r) => (r.p1 - r.p0) / r.p0);
  const value = rets.length >= 20 ? median(rets) : null; // 样本太少的基准不可信，宁可不算
  marketCache.set(day, value);
  return value;
}

let pending = 0;
const scored = { SELL: [], SELL_STRONG: [], HOLD: [] };
for (const s of signals) {
  const fwd = forwardReturn(s);
  const base = fwd === null ? null : marketBaseline(s.decided_at);
  if (fwd === null || base === null) {
    pending += 1;
    continue;
  }
  scored[s.action]?.push(fwd - base);
}

console.log("");
console.log("=== 命中率（未到期或缺对照基准的样本已剔除）===");
console.log(`未到期/无法评估：${pending} 条`);
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

console.log("");
console.log("读法：卖出类的\"命中率\"就是 1 − 假信号率。要替换 v1，至少得看到卖出类命中率明显过半、");
console.log("     且超额中位数是负的（说明卖在了相对高点），同时 HOLD 那行没有系统性判反。");
console.log("     样本量太小时这些数字没有意义——回测里 15~20% 档的为负占比也才 61%，");
console.log("     几十条样本的波动完全能盖过这个幅度，至少要攒到三位数再下结论。");
