// 把"稀缺类型"的待审核异常事件整理成一份带上下文的人工判断清单。
//
// 用法（要在能读到真实数据库的地方跑，也就是云端容器里，本机 data/db.sqlite 是旧快照）：
//   node scripts/list-scarce-anomalies.mjs > data/scarce-anomalies.md
//
// 为什么单独挑这几类：price_zscore 已经有 485 条人工标注，再标同类的边际价值趋零
// （7-20/7-25/7-27 三次特征分析复跑都"跑了没质变"就是这个原因）；真正稀缺的是
// manipulation_score / momentum_chase / washout_signal 这三类，一条顶几十条 z-score。
//
// **这个脚本只整理上下文，不做任何"是不是操盘"的判断**——那个判断的全部价值来自
// 项目所有者的小道消息，价格数据里没有。由 AI 按价格形态代判等于用模型的特征生成
// 模型的标签，是循环论证，跑出来的 AUC 会虚高且事后无法察觉（见 HANDOFF 踩坑 35）。
import Database from "better-sqlite3";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

// 顺序就是审核优先级：联动两类排前面（2026-08-13 起，它们是"要不要给 group_linkage
// 开推送"这个决定的唯一输入），后面三类是老的稀缺类型。
const SCARCE_METRICS = [
  "group_linkage",
  "collection_linkage",
  "manipulation_score",
  "momentum_chase",
  "washout_signal",
];

// --sample N：随机抽 N 条（用于估"值得看的比例"，不用等 200 多条全审完）。
// --seed S：抽样种子，默认 1。**固定种子是有意的**——同一个种子每次抽到同一批，
// 审到一半重跑清单不会换一组样本，否则估出来的比例是有偏的（换到不喜欢的就重抽）。
const args = parseScriptArgs({
  name: "list-scarce-anomalies",
  usage: "node scripts/list-scarce-anomalies.mjs [--sample N] [--seed S] [库文件]",
  values: {
    "--sample": { parse: Number, default: 0, label: "抽样条数" },
    "--seed": { parse: Number, default: 1, label: "抽样种子" },
  },
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const SAMPLE_SIZE = args.values["--sample"];
const SAMPLE_SEED = args.values["--seed"];
// 事件前后各看多久：前 7 天给"异动之前是什么状态"，后 14 天覆盖 T+7 锁定期满之后的走势，
// 因为 2026-07-15 新规下买入方 7 天内没法卖，第 7 天之后的价格才是真正能兑现的那个价。
const DAYS_BEFORE = 7;
const DAYS_AFTER = 14;

const db = new Database(resolveDbPath(args.dbPath), { readonly: true });

const esc = (s) => String(s ?? "").replaceAll("|", "\\|");
const pct = (a, b) => (a === null || b === null || !b ? "—" : `${(((a - b) / b) * 100).toFixed(1)}%`);
const yuan = (v) => (v === null || v === undefined ? "—" : `¥${v.toFixed(2)}`);

const allEvents = db
  .prepare(
    `SELECT id, item_name, platform, metric, detected_at, value, price, context
     FROM anomaly_events
     WHERE status = 'pending' AND metric IN (${SCARCE_METRICS.map(() => "?").join(",")})
     ORDER BY metric, detected_at DESC`
  )
  .all(...SCARCE_METRICS);

// 可复现的伪随机（LCG）。用 Math.random 的话每次抽到的都不是同一批，
// "审了 25 条估出来的比例"就没法回溯到具体是哪 25 条。
function seededShuffle(list, seed) {
  const arr = [...list];
  let state = seed >>> 0 || 1;
  for (let i = arr.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const events = SAMPLE_SIZE
  ? seededShuffle(allEvents, SAMPLE_SEED)
      .slice(0, SAMPLE_SIZE)
      .sort(
        (a, b) =>
          SCARCE_METRICS.indexOf(a.metric) - SCARCE_METRICS.indexOf(b.metric) ||
          b.detected_at.localeCompare(a.detected_at)
      )
  : allEvents;

// 取离目标时间最近的一条快照。事件时间点未必正好有快照（同步偶尔缺轮次、K线回填是整点），
// 按时间差排序取最近的比精确匹配更稳，容差 12 小时以内才算数。
const nearestSnapshot = db.prepare(
  `SELECT price, captured_at FROM price_snapshots
   WHERE item_name = ? AND platform = ?
     AND captured_at BETWEEN datetime(?, '-12 hours') AND datetime(?, '+12 hours')
   ORDER BY ABS(julianday(captured_at) - julianday(?)) LIMIT 1`
);
const latestSnapshot = db.prepare(
  `SELECT price, captured_at FROM price_snapshots
   WHERE item_name = ? AND platform = ? ORDER BY captured_at DESC LIMIT 1`
);
const metaStmt = db.prepare(`SELECT collection, rarity, rarity_rank FROM item_metadata WHERE item_name = ?`);
const inventoryStmt = db.prepare(
  `SELECT COUNT(*) n, MAX(buy_price) buy_price FROM inventory WHERE item_name = ? AND buy_price > 0`
);
const watchStmt = db.prepare(`SELECT COUNT(*) n FROM watchlist WHERE item_name = ?`);
const tagStmt = db.prepare(
  `SELECT start_date, end_date, confidence, note FROM manipulation_tags WHERE item_name = ? ORDER BY start_date`
);
// 同收藏品的其他饰品在同一天有没有也被检测出异动——"上级被拉、下级跟涨"是这个项目的
// 核心业务假设，同期有没有伴生异动是判断单品异动的关键旁证。
const siblingStmt = db.prepare(
  `SELECT e.item_name, e.metric, e.value, m.rarity, m.rarity_rank
   FROM anomaly_events e JOIN item_metadata m ON m.item_name = e.item_name
   WHERE m.collection = ? AND e.item_name != ?
     AND substr(e.detected_at, 1, 10) BETWEEN date(?, '-1 day') AND date(?, '+1 day')
   ORDER BY m.rarity_rank DESC LIMIT 8`
);

function priceAt(itemName, platform, isoTime) {
  const row = nearestSnapshot.get(itemName, platform, isoTime, isoTime, isoTime);
  return row ? row.price : null;
}

const shift = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();

const METRIC_LABEL = {
  group_linkage: "同组联动（胶囊/组织）",
  collection_linkage: "同收藏品联动",
  manipulation_score: "操盘嫌疑分",
  momentum_chase: "追涨风险",
  washout_signal: "洗盘/深回撤",
};

// 同组其他饰品在触发那一刻的表现。联动预警的判据就是"同组的东西是不是一起动了"，
// 而"同期有没有也被检测出异动"只回答了一半——检测器有冷却和阈值，没触发不等于没动。
// 所以这里直接看价格：同组每个饰品在 T 时刻的 24h 涨跌幅。
const groupMembersStmt = db.prepare(
  `SELECT item_name FROM item_metadata WHERE collection = ? AND item_name != ? LIMIT 12`
);

const out = [];
out.push("# 待判断异常事件清单（稀缺类型）");
out.push("");
out.push(
  SAMPLE_SIZE
    ? `> 生成时间：${new Date().toISOString()}　**随机抽样 ${events.length} 条**（种子 ${SAMPLE_SEED}，` +
        `总量 ${allEvents.length} 条）。抽样是为了估"值得看的比例"——审完这批就能拿这个比例` +
        `乘上日均触发量，决定要不要开推送，不必等全部审完。`
    : `> 生成时间：${new Date().toISOString()}　共 **${events.length}** 条`
);
out.push("");
out.push(
  "这份清单**只整理上下文，不含任何「是不是操盘」的判断**——那个判断要靠你的小道消息，" +
    "价格数据里没有这个信息。判断不了的直接标「正常波动」（dismissed），那同样是有效的负样本，" +
    "不是「没处理」。"
);
out.push("");
out.push("**三种状态怎么选**（下面这个流向决定了标注的真实价值，见 HANDOFF 踩坑 34）：");
out.push("");
out.push("- **确认操盘** → 会写进 `manipulation_tags` 表，**那才是特征分析脚本读的正样本**，最有价值");
out.push("- **外部事件** → 被脚本读作排除窗口（5-22 更新、7-15 新规这类全市场事件）");
out.push("- **正常波动** → 目前没有脚本读它，但将来要当负样本用，标了不亏");
out.push("");
out.push("**价格列怎么看**：`T` 是事件触发那一刻的价；`T+7` 之后才是 2026-07-15 新规下真正能兑现的价" +
  "（买入方 7 天内锁定不能卖）；`当前` 是最新一条快照。涨跌幅都是相对 `T`。");
out.push("");

// 总览表放最前面：41 条逐条读完再决定看哪几条太累，先给一眼能扫完的索引。
// 排序不做任何"哪条更可疑"的加权（那就是变相代判了），只按类型+时间，跟下面正文一致。
out.push("## 总览");
out.push("");
out.push("| # | 饰品 | 类型 | 归属 | 已有操盘标记 | T 价格 | 至今 |");
out.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const e of events) {
  const inv = inventoryStmt.get(e.item_name);
  const tagCount = tagStmt.all(e.item_name).length;
  const latest = latestSnapshot.get(e.item_name, e.platform);
  const owner = inv.n > 0 ? `持仓${inv.n}件` : watchStmt.get(e.item_name).n > 0 ? "观察池" : "—";
  out.push(
    `| ${e.id} | ${esc(e.item_name)} | ${METRIC_LABEL[e.metric]} | ${owner} | ${tagCount || "—"} ` +
      `| ${yuan(e.price)} | ${pct(latest?.price ?? null, e.price)} |`
  );
}
out.push("");

for (const metric of SCARCE_METRICS) {
  const group = events.filter((e) => e.metric === metric);
  if (group.length === 0) continue;
  out.push(`## ${METRIC_LABEL[metric]}（${metric}）　${group.length} 条`);
  out.push("");

  for (const e of group) {
    const meta = metaStmt.get(e.item_name) ?? {};
    const inv = inventoryStmt.get(e.item_name);
    const inWatch = watchStmt.get(e.item_name).n > 0;
    const tags = tagStmt.all(e.item_name);
    const latest = latestSnapshot.get(e.item_name, e.platform);

    const t = e.price;
    const before = priceAt(e.item_name, e.platform, shift(e.detected_at, -DAYS_BEFORE));
    const before24h = priceAt(e.item_name, e.platform, shift(e.detected_at, -1));
    const after7 = priceAt(e.item_name, e.platform, shift(e.detected_at, 7));
    const after14 = priceAt(e.item_name, e.platform, shift(e.detected_at, DAYS_AFTER));

    out.push(`### #${e.id}　${esc(e.item_name)}`);
    out.push("");
    const holdNote =
      inv.n > 0
        ? `**持仓 ${inv.n} 件，购入价 ${yuan(inv.buy_price)}**（buy_price>0 = 当初凭消息买的）`
        : inWatch
          ? "观察池"
          : "既不在持仓也不在观察池";
    out.push(
      `- 触发：${e.detected_at.slice(0, 16).replace("T", " ")}　平台 ${e.platform}　指标值 ${e.value.toFixed(1)}`
    );
    out.push(`- 归属：${holdNote}`);
    if (meta.collection) {
      out.push(`- 收藏品：「${esc(meta.collection)}」　品质：${meta.rarity ?? "—"}（rank ${meta.rarity_rank ?? "—"}）`);
    }
    if (e.context) out.push(`- 检测器给的上下文：${esc(e.context)}`);
    if (tags.length > 0) {
      out.push(
        `- ⚠️ 这个饰品已有 ${tags.length} 条操盘标记：` +
          tags
            .map((tg) => `${tg.start_date}~${tg.end_date ?? "至今"}(${tg.confidence})`)
            .join("、")
      );
    }
    out.push("");
    out.push("| T-7天 | T-24小时 | **T（触发）** | T+7天 | T+14天 | 当前 |");
    out.push("| --- | --- | --- | --- | --- | --- |");
    out.push(
      // T-7 / T-24h 那两格的涨跌幅是"从那时涨/跌到 T"（分母是那时），跟右边几格的
      // "从 T 涨/跌到那时"方向一致，都读作"时间往后走，价格怎么变"。
      // 反过来写会让一段下跌显示成正数。
      `| ${yuan(before)}<br>→T ${pct(t, before)} | ${yuan(before24h)}<br>→T ${pct(t, before24h)} ` +
        `| **${yuan(t)}** | ${yuan(after7)}<br>${pct(after7, t)} ` +
        `| ${yuan(after14)}<br>${pct(after14, t)} | ${yuan(latest?.price ?? null)}<br>${pct(latest?.price ?? null, t)} |`
    );
    if (after7 === null) {
      const hoursOld = (Date.now() - new Date(e.detected_at).getTime()) / 3600000;
      out.push("");
      out.push(
        `- ⏳ 触发才 ${Math.round(hoursOld)} 小时，**T+7 还没到**（右边「当前」列是目前为止的走势）——` +
          `拿不准就先放着，过一周重跑这份清单再看`
      );
    }
    out.push("");

    if (meta.collection) {
      const siblings = siblingStmt.all(meta.collection, e.item_name, e.detected_at, e.detected_at);
      if (siblings.length > 0) {
        out.push(
          `- 同收藏品同期（±1天）也异动的：` +
            siblings
              .map((s) => `${esc(s.item_name)}(${s.rarity ?? "?"}, ${s.metric} ${s.value.toFixed(1)})`)
              .join("；")
        );
      } else {
        out.push("- 同收藏品同期无伴生异动");
      }

      // 同组成员在 T 时刻的 24h 涨跌——检测器有阈值和冷却，"没触发"不等于"没动"，
      // 判联动值不值得看，要看的是同组是不是真的一起动了。
      const members = groupMembersStmt.all(meta.collection, e.item_name);
      const moves = members
        .map((m) => {
          const at = priceAt(m.item_name, e.platform, e.detected_at);
          const prior = priceAt(m.item_name, e.platform, shift(e.detected_at, -1));
          return at !== null && prior ? { name: m.item_name, move: (at - prior) / prior } : null;
        })
        .filter((x) => x !== null)
        .sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
      if (moves.length > 0) {
        const movedUp = moves.filter((m) => m.move > 0.03).length;
        out.push(
          `- 同组 ${moves.length} 个成员在 T 时刻的 24h 涨跌（涨超 3% 的 ${movedUp} 个）：` +
            moves
              .slice(0, 6)
              .map((m) => `${esc(m.name)} ${(m.move * 100).toFixed(1)}%`)
              .join("；")
        );
      }
      out.push("");
    }
    out.push(`- 详情页：\`/item/${encodeURIComponent(e.item_name)}\`　审核页：\`/anomalies\``);
    out.push("");
  }
}

console.log(out.join("\n"));
