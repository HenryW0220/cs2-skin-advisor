// 一次性脚本：把"人工无从判断"和"实测确认率为 0"的待审核异常事件移出审核队列。
//
// 用法：
//   node scripts/archive-unreviewable-anomalies.mjs            # 演练，只打印不写库
//   node scripts/archive-unreviewable-anomalies.mjs --apply    # 真正执行
//   node scripts/archive-unreviewable-anomalies.mjs --revert   # 回滚本脚本归档过的记录
//
// 为什么用 archived 而不是 dismissed：dismissed 的语义是"人看过，判断是正常波动"，
// 是一条真实负标签（见 db/migrations/007 的注释，将来要拿来当负样本）；这个脚本没有
// 做任何"是不是操盘"的判断，只是按机械规则清理注意力，混进 dismissed 会污染将来的负样本。
//
// 两条归档规则的依据（都不含操盘判断）：
//   1. buy_price=0 的开箱品：购入渠道未知，用户没有消息来源，根本无从判断是不是操盘。
//      /anomalies 页面本来就不展示这批（见 HANDOFF），它们只是白白占着 pending 计数。
//   2. 触发价 < ¥5：用已人工审核的 485 条 price_zscore 回算，这一档 121 条**确认操盘 0 条**
//      （¥5-20 是 56%、¥20-100 是 99%、¥100+ 是 95%），低价品的"异常"是报价精度的机械结果。
//      lib/anomaly-scan.ts 的 MIN_PRICE_FOR_ANOMALY_SCAN 已同步提到 5，从源头止血。
import Database from "better-sqlite3";

const MIN_PRICE = 5;
const NOTE_PREFIX = "机械归档";

const apply = process.argv.includes("--apply");
const revert = process.argv.includes("--revert");

const db = new Database("data/db.sqlite");

if (revert) {
  const stmt = db.prepare(
    `UPDATE anomaly_events SET status = 'pending', review_note = NULL, reviewed_at = NULL
     WHERE status = 'archived' AND review_note LIKE ?`
  );
  if (!apply) {
    const n = db
      .prepare(
        "SELECT COUNT(*) c FROM anomaly_events WHERE status = 'archived' AND review_note LIKE ?"
      )
      .get(`${NOTE_PREFIX}%`).c;
    console.log(`[演练] 会把 ${n} 条 archived 恢复成 pending。加 --apply 真正执行。`);
  } else {
    const r = stmt.run(`${NOTE_PREFIX}%`);
    console.log(`已恢复 ${r.changes} 条为 pending。`);
  }
  db.close();
  process.exit(0);
}

// buy_price=0 的开箱品；注意同一饰品可能既有 buy_price>0 的行也有 =0 的行，
// 只有"全部持仓行都是 0 且不在观察池"才算真正无从判断，否则用户是有消息来源的。
const unjudgeable = new Set(
  db
    .prepare(
      `SELECT i.item_name FROM inventory i
       GROUP BY i.item_name
       HAVING MAX(i.buy_price) = 0
          AND i.item_name NOT IN (SELECT item_name FROM watchlist)`
    )
    .all()
    .map((r) => r.item_name)
);

const pending = db.prepare("SELECT * FROM anomaly_events WHERE status = 'pending'").all();

const toArchive = [];
for (const e of pending) {
  if (unjudgeable.has(e.item_name)) {
    toArchive.push([e, "开箱品(buy_price=0)，购入渠道未知，无从判断是否操盘"]);
  } else if (e.price < MIN_PRICE) {
    toArchive.push([e, `触发价 ¥${e.price.toFixed(2)} < ¥${MIN_PRICE}，该档已审核样本确认率 0%`]);
  }
}

const byReason = {};
for (const [, reason] of toArchive) {
  const key = reason.startsWith("开箱品") ? "开箱品" : "低价品";
  byReason[key] = (byReason[key] || 0) + 1;
}

console.log(`待审核总数 ${pending.length}`);
console.log(`拟归档 ${toArchive.length} 条：${JSON.stringify(byReason)}`);
console.log(`归档后剩余 ${pending.length - toArchive.length} 条`);

if (!apply) {
  console.log("");
  console.log("样例（前 5 条）：");
  for (const [e, reason] of toArchive.slice(0, 5)) {
    console.log(`  #${e.id} ${e.item_name} ${e.metric} ¥${e.price} → ${reason}`);
  }
  console.log("");
  console.log("[演练模式] 没有写库。确认无误后加 --apply 执行，之后可用 --revert --apply 回滚。");
  db.close();
  process.exit(0);
}

const update = db.prepare(
  "UPDATE anomaly_events SET status = 'archived', review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'"
);
const run = db.transaction((list) => {
  let n = 0;
  for (const [e, reason] of list) {
    n += update.run(`${NOTE_PREFIX}：${reason}`, e.id).changes;
  }
  return n;
});

const changed = run(toArchive);
console.log(`已归档 ${changed} 条。回滚：node scripts/archive-unreviewable-anomalies.mjs --revert --apply`);
db.close();
