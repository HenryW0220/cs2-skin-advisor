// 采集 régime 边界检测。用法：node scripts/report-regime-boundaries.mjs [库文件] [--step-threshold 0.2]
//
// 为什么要有这个脚本（2026-08-14）：算"历史均值"当对照基数时踩的。
// price_snapshots 一路回溯到 2025-06，全表平均是每小时 280 行，而最近 7 天的中位数是
// 每小时 3236 行——**相差 11 倍，两个数都算对了**。错的是把它们当成同一个总体的两次抽样：
// 2025 年那段是少量饰品的稀疏 K 线回填，现在是 325 个饰品 × 多平台 × 整点同步 + 10 分钟
// 快速同步。**基数本身是对的数，只是来自另一个世界。**
//
// 这跟"存量 vs 流量"（price_snapshots.volume 是在售量不是成交量）是同构的失效模式：
// 那次是**字段的语义**跟名字对不上，这次是**同一字段的语义在时间轴上变了**。
// 两个都不报错，两个都给出一个可以拿去汇报的数。
//
// 所以：**任何跨时间的聚合，先确认整个区间属于同一 régime。** 配置变更（追踪范围、
// 平台数、采集频率、迁移、门槛调整）就是 régime 边界，跨界的均值没有意义。
// 这个脚本把边界从数据里**测出来**，而不是靠记忆列——记忆会漏，而这份清单的价值随时间只增不减。
import Database from "better-sqlite3";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "report-regime-boundaries",
  usage: "node scripts/report-regime-boundaries.mjs [库文件] [--step-threshold R] [--min-rows N]",
  values: {
    // 相邻两天的"参与饰品数"或"行数"变化超过这个比例就算一个边界候选。
    // 0.2 是**观察阈值不是判据**：它只负责把候选摆出来给人看，不做任何自动结论，
    // 所以宁可宽一点（多几条噪音）也不要漏掉真的配置变更。
    "--step-threshold": { parse: Number, default: 0.2, label: "阶跃阈值" },
    // 太早期只有个位数行的日子会让比例失真，低于这个行数的天不参与阶跃判断
    "--min-rows": { parse: Number, default: 100, label: "参与判断的最小日行数" },
  },
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});

const db = new Database(resolveDbPath(args.dbPath), { readonly: true });
const stepThreshold = args.values["--step-threshold"];
const minRows = args.values["--min-rows"];

const days = db
  .prepare(
    `SELECT substr(captured_at, 1, 10) day,
            COUNT(*) rows,
            COUNT(DISTINCT item_name) items,
            COUNT(DISTINCT platform) platforms
     FROM price_snapshots GROUP BY 1 ORDER BY 1`
  )
  .all();

console.log(`共 ${days.length} 个自然日：${days[0]?.day} ~ ${days[days.length - 1]?.day}`);
// 日历跨度远大于有数据的天数 = 中间大段没有采集，本身就说明早期跟现在不是一回事
const calendarDays =
  Math.round((Date.parse(days[days.length - 1].day) - Date.parse(days[0].day)) / 86400000) + 1;
if (calendarDays > days.length * 1.2) {
  console.log(
    `⚠️ 日历跨度 ${calendarDays} 天但只有 ${days.length} 天有数据——中间大段是空的，` +
      `**全区间的任何"日均"都没有意义**。`
  );
}

// 最后一天多半没过完（尤其对着备份副本跑时，数据截止在备份时刻），
// 它的行数天然偏低，参与阶跃判断会稳定产生一条假边界——第一版就是这么报出
// "2026-08-14 行数 74090 → 9391" 的。**这是脚本自己的作息不是系统的异常。**
const lastDay = days[days.length - 1];
const completeDays = days.slice(0, -1);
console.log(
  `（最后一天 ${lastDay.day}（${lastDay.rows} 行）不参与阶跃判断——它多半没过完，算进去必然报一条假边界）`
);
console.log("");

// ---------- 测出来的阶跃 ----------
const rel = (a, b) => (b === 0 ? Infinity : Math.abs(a - b) / b);
const boundaries = [];
for (let i = 1; i < completeDays.length; i++) {
  const prev = completeDays[i - 1];
  const cur = completeDays[i];
  if (prev.rows < minRows || cur.rows < minRows) continue;
  const reasons = [];
  if (rel(cur.items, prev.items) > stepThreshold) {
    reasons.push(`参与饰品 ${prev.items} → ${cur.items}`);
  }
  if (rel(cur.rows, prev.rows) > stepThreshold) {
    reasons.push(`行数 ${prev.rows} → ${cur.rows}`);
  }
  if (cur.platforms !== prev.platforms) {
    reasons.push(`平台数 ${prev.platforms} → ${cur.platforms}`);
  }
  if (reasons.length) boundaries.push({ day: cur.day, reasons });
}

console.log(`=== 从数据里测出来的 régime 边界候选（阶跃 >${(stepThreshold * 100).toFixed(0)}%）===`);
console.log("这些是**候选不是判据**——脚本只负责把台阶摆出来，是不是真的配置变更要人去对。");
for (const b of boundaries) console.log(`  ${b.day}  ${b.reasons.join("；")}`);
if (!boundaries.length) console.log("  （没有检测到阶跃）");

// ---------- 已知的配置变更 ----------
// 这份清单靠人维护，跟上面测出来的对照着看：**测出来但清单里没有 = 有一次没记录的变更；
// 清单里有但测不出来 = 那次变更没有改变采集规模（也是有用的信息）。**
const KNOWN = [
  ["2026-07-17", "K 线回填把候选池历史灌进来（行数 +27%，平台数 1 → 5）"],
  ["2026-07-20", "求购深度字段开始入库（迁移 013）"],
  ["2026-07-21", "迁到 Oracle 云端 VM，采集从本机 Windows 改成容器常驻"],
  // 数据实测：参与饰品 673 → 325。方向跟"观察池扩容"相反——673 那几天是候选池
  // 回填在写历史，回填一停就落回稳态追踪的 325 个。**别把回填期的饰品数当追踪规模。**
  ["2026-07-22", "候选池回填结束，每日参与饰品回落到稳态的 325"],
  // 注意这一天**没有**饰品数台阶，只有行数台阶（17503 → 30539）：C5 提频是"同样的饰品
  // 写得更勤"，不是"追踪更多饰品"。HANDOFF 里"观察池扩容到 338"说的是观察池条目数，
  // 跟每日有快照的饰品数（325）不是一个口径。
  ["2026-07-26", "C5 高频 tick 上线（每 10 分钟一轮），行数近乎翻倍"],
  ["2026-07-27", "OOM 崩溃循环开始（每小时崩一次，持续到 07-30 修复）"],
  ["2026-07-31", "MIN_PRICE_FOR_ANOMALY_SCAN 从 1 提到 5"],
  ["2026-08-13", "规则引擎删掉趋势项，score 集合塌缩成 {-30,0,+30}"],
  ["2026-08-14", "大盘基准物化表加口径版本（迁移 024）"],
];
console.log("");
console.log("=== 已知配置变更（人工维护，跟上面对照）===");
const detected = new Set(boundaries.map((b) => b.day));
for (const [day, what] of KNOWN) {
  const hit = detected.has(day);
  const row = days.find((d) => d.day === day);
  console.log(
    `  ${day}  ${hit ? "✔ 数据里能看到台阶" : "· 数据里没有明显台阶"}  ` +
      `${row ? `（当天 ${row.rows} 行 / ${row.items} 个饰品）` : "（当天无数据）"}  ${what}`
  );
}
const unexplained = boundaries.filter((b) => !KNOWN.some(([d]) => d === b.day));
if (unexplained.length) {
  console.log("");
  console.log("⚠️ 下面这些台阶在已知清单里找不到对应的配置变更——要么是漏记了一次变更，");
  console.log("   要么是外部原因（接口挂了、限流、崩溃）。查清楚再往清单里补：");
  for (const b of unexplained) console.log(`     ${b.day}  ${b.reasons.join("；")}`);
}

console.log("");
console.log("怎么用：算任何跨时间的均值/基数之前，先确认整个区间不跨上面任何一条边界。");
console.log("        跨了就分段算，或者干脆只取最近一个 régime（report-write-rate.mjs 就是这么做的）。");
