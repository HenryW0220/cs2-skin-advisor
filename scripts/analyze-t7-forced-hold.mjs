// T+7 强制持有模拟：2026-07-15 交易保护新规后，买入的饰品要锁定 7 天才能再交易。
// 这个脚本回答"就算预测完美（每次都在操盘窗口开始当天买入），T+7 下还能赚到钱吗"——
// 对每个 manipulation_tags 窗口模拟"窗口开始当天买入、第 7 天才能卖"，对比窗口内峰值。
//
// 用法：node scripts/analyze-t7-forced-hold.mjs
//
// 注意：所有窗口都来自 2026-07-15 之前的旧规则市场。庄家吸货是中长线过程（用户口述），
// 拉升时手里的货早已过锁定期、出一小部分就回本，所以 T+7 并不约束庄家的节奏，
// 不能指望新规让快盘消失——这个模拟结果对新规时代大概率仍然成立。
import Database from "better-sqlite3";

const db = new Database(new URL("../data/db.sqlite", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), {
  readonly: true,
});

const DAY = 24 * 3600 * 1000;
const FEE_THRESHOLD = 0.02; // C5/悠悠手续费约 1% + 滑点余量，净赚门槛按 2% 算

const tags = db
  .prepare("SELECT item_name, start_date FROM manipulation_tags WHERE start_date IS NOT NULL")
  .all();

let analyzed = 0;
let peakWithin7 = 0;
let sellAt7Profitable = 0;
let sellAt7KeepsHalfPeak = 0;
const details = [];

for (const tag of tags) {
  const start = new Date(`${tag.start_date}T00:00:00Z`).getTime();
  const plat = db
    .prepare(
      "SELECT platform, COUNT(*) c FROM price_snapshots WHERE item_name=? GROUP BY platform ORDER BY c DESC LIMIT 1"
    )
    .get(tag.item_name);
  if (!plat) continue;
  const rows = db
    .prepare(
      `SELECT price, captured_at FROM price_snapshots
       WHERE item_name=? AND platform=? AND captured_at>=? AND captured_at<=?
       ORDER BY captured_at ASC`
    )
    .all(tag.item_name, plat.platform, new Date(start).toISOString(), new Date(start + 21 * DAY).toISOString());
  if (rows.length < 24) continue;

  const buyPrice = rows[0].price;
  if (buyPrice <= 0) continue;
  let peak = -Infinity;
  let peakT = null;
  let priceAt7 = null;
  for (const r of rows) {
    const t = new Date(r.captured_at).getTime();
    if (r.price > peak) {
      peak = r.price;
      peakT = t;
    }
    if (priceAt7 === null && t >= start + 7 * DAY) priceAt7 = r.price;
  }
  if (priceAt7 === null) continue;

  analyzed += 1;
  const peakDay = (peakT - start) / DAY;
  const ret7 = (priceAt7 - buyPrice) / buyPrice;
  const retPeak = (peak - buyPrice) / buyPrice;
  if (peakDay <= 7) peakWithin7 += 1;
  if (ret7 > FEE_THRESHOLD) sellAt7Profitable += 1;
  if (retPeak > 0 && ret7 >= retPeak * 0.5) sellAt7KeepsHalfPeak += 1;
  details.push({
    item: tag.item_name,
    start: tag.start_date,
    peakDay: Number(peakDay.toFixed(1)),
    retPeak: Number((retPeak * 100).toFixed(1)),
    ret7: Number((ret7 * 100).toFixed(1)),
  });
}

const pct = (n) => `${((n / analyzed) * 100).toFixed(0)}%`;
console.log(`可分析窗口: ${analyzed}/${tags.length}`);
console.log(`峰值出现在 7 天以内（锁定期内过峰，卖不掉）: ${peakWithin7} (${pct(peakWithin7)})`);
console.log(`第 7 天卖出仍净赚 >${FEE_THRESHOLD * 100}%: ${sellAt7Profitable} (${pct(sellAt7Profitable)})`);
console.log(`第 7 天卖出保住峰值收益一半以上: ${sellAt7KeepsHalfPeak} (${pct(sellAt7KeepsHalfPeak)})`);

details.sort((a, b) => b.ret7 - a.ret7);
console.log("\n第 7 天收益最好的 5 个（慢盘，T+7 下仍可交易的形态）:");
for (const d of details.slice(0, 5)) console.log(" ", JSON.stringify(d));
console.log("最差的 5 个:");
for (const d of details.slice(-5)) console.log(" ", JSON.stringify(d));

db.close();
