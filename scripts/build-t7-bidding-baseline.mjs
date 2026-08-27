// 买入侧 A6：**求购深度**的 T+7 净收益分档表。
// 用法：node scripts/build-t7-bidding-baseline.mjs [库文件] [--since YYYY-MM-DD] [--hour-pick first|noon]
//
// ============================================================================
// 一、为什么现在能做了（WAITING.md 第 7 项）
// ============================================================================
// HYPOTHESES §2.3 把 `bidRatio` / `bidAskRatioRel` 记成"已验证未上线"，卡在
// "只有 16 个饰品、两周数据"。**那个 16 是「有操盘标注」的饰品数**——当时的检验拿
// 人工标注当标签，所以样本上限就是被标注过的那些饰品。
//
// **2026-08-15 买入侧已改用 T+7 自动标签，不再需要标注**（PLAN.md C 阶段，
// build-t7-entry-baseline.mjs 文件头「为什么换标签」那一节）。约束随之失效：
// 能用的是**全部有求购数据的饰品**。实测 2026-08-22 的库：373 个饰品、649428 行、
// 2026-07-20 ~ 08-22 共 34 天，其中 325 个饰品有 ≥504 小时。
//
// **这是买入侧唯一一条有正面证据、又不在那 35 个已被否掉的档位里的候选**
// （§2.4 那一整行"价格特征撑起买入侧"已经证伪，明写"要重开只能靠新数据源"——
// 现成的新数据源只有求购深度这一个）。
//
// ============================================================================
// 二、判据（跟 build-t7-entry-baseline.mjs 逐条对齐，不另立一套）
// ============================================================================
// 1. **按饰品去重**：同一饰品同一天只取一个样本，取当天最早那个合格小时桶。
//    取哪个小时必须与结果无关——按"求购最厚的那个小时"去重就是每天挑一次最优点。
// 2. **只报中位数，不报均值**（踩坑 44 ①：均值被孤例主导）。
// 3. 每档同时给：可评估样本数、饰品数、中位为正/为负的饰品数、符号检验 p。
// 4. **AUC 只用于淘汰，不用于录取**（踩坑 46）。
// 5. **régime**：见下面 --since 那段。**这一条对本脚本比对价格脚本更要紧**，理由在那里。
// 6. **绝对收益和超额都要报**，录取判据写死成：
//    **绝对收益中位数 ≥ 成本线，且超额中位数 > 0**。
//    买入侧决定的是"要不要动用现金"，对照物是现金不是市场 ⇒ 必须看绝对值。
//    只过超额那条的档位含义是"跌得比大盘少"，那不是买点。
//
// ⚠️ **一条本脚本独有的、比上面六条都更容易翻车的**：
// `bidding_count` **只有部分平台返回**，而 HANDOFF 第四节 0.6 的判断标准是
// "问这个量的定义里有没有隐含『平台集合稳定』这个前提"——**求购深度类明确落在"要复核"
// 那一边**，是那份清单上点名的四类之一。所以这里的参考平台不能沿用价格口径的
// C5 优先，而是按"求购数据最多"选（`bidding-features.mjs` 里那一份），
// 并且**每档都打印它用到了几个平台**，让平台构成的变化看得见。
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  BIDDING_DATA_START,
  biddingHourlySeries,
  biddingPlatform,
  computeBiddingFeatures,
  precomputeSeries,
} from "./bidding-features.mjs";
import {
  assertBaselineCoverage,
  assertBaselineTable,
  baselineProvenance,
  loadBaseline,
} from "./market-baseline-store.mjs";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

const args = parseScriptArgs({
  name: "build-t7-bidding-baseline",
  usage:
    "node scripts/build-t7-bidding-baseline.mjs [库文件] [--since YYYY-MM-DD] [--hour-pick first|noon]",
  values: {
    // --since 在这个脚本上的作用跟价格脚本不同：求购数据本身就只有 2026-07-20 之后的，
    // 早已落在单一 régime 内（2026-07-22 回填结束、落回 325 饰品稳态）。所以主口径
    // **不需要** --since，留这个参数是为了能手动切掉 07-26（C5 高频 tick 上线）和
    // 07-27（OOM 崩溃循环）那两条已知边界做稳健性对照。
    "--since": { parse: String, default: "", label: "只用这个日期之后的样本" },
    "--hour-pick": { parse: String, default: "first", label: "同一饰品同一天取哪个小时" },
  },
  positionals: [{ name: "dbPath", label: "库文件", default: null }],
});
const sinceDay = args.values["--since"];
const sinceMs = sinceDay ? Date.parse(`${sinceDay}T00:00:00.000Z`) : null;
if (sinceDay && !Number.isFinite(sinceMs)) {
  console.error(`✗ --since 的值 "${sinceDay}" 不是合法日期（要 YYYY-MM-DD）`);
  process.exit(1);
}
const hourPick = args.values["--hour-pick"];
if (hourPick !== "first" && hourPick !== "noon") {
  console.error(`✗ --hour-pick 只能是 first 或 noon，收到 "${hourPick}"`);
  process.exit(1);
}

const db = new Database(resolveDbPath(args.dbPath), { readonly: true });

const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
const HORIZON_DAYS = 7; // T+7 锁定期，不是可调窗口（PLAN.md 原则 6：交易保护新规）
// 求购数据只有一个月出头，套价格脚本那个 24×(7+14)=504 小时的历史门槛会把样本砍掉一大半。
// 这里的门槛只保证"算得出 168 小时基线 + 24 小时回看 + T+7 前瞻"，即 168+24+168=360 小时。
// **这是一处有意的口径分岔，必须写明**：它意味着本表参与的饰品集合跟价格那张表不同，
// 两张表的档位**不可以直接并排相减**（四点五 #4.6：比较两个数之前先确认是同一种统计量）。
const HISTORY_GATE_HOURS = 360;
const MIN_DAYS_PER_ITEM = 2; // 跟 build-t7-entry-baseline.mjs 一致：挡住"一天定一票"
const AUC_ELIMINATION_FLOOR = 0.5; // 只淘汰不录取，理由见 build-t7-entry-baseline.mjs

function readCostLine() {
  const src = readFileSync(new URL("../lib/rules/cost-line.ts", import.meta.url), "utf8");
  const pick = (name) => {
    const m = src.match(new RegExp(`export const ${name} = ([0-9.]+);`));
    if (!m) {
      console.error(`✗ 在 lib/rules/cost-line.ts 里找不到 ${name}——成本线是本脚本的唯一判据，不能猜。`);
      process.exit(1);
    }
    return Number(m[1]);
  };
  return { min: pick("ROUND_TRIP_COST_MIN"), target: pick("ROUND_TRIP_COST_TARGET") };
}
const COST = readCostLine();

// ============================================================================
// 分档定义
// ============================================================================
// 假设方向来自 HYPOTHESES §2.3 / §3.1：**吸货期庄家在下方堆求购单，买盘变厚**。
// 所以厚度越高、未来 7 天越好。**只测这一个方向**，反方向不另开一组——那是搜。
//
// 边界取"相对自身基线"的倍数而不是绝对值：`bidCount` 的绝对值被"贵价品挂单天然少"
// 污染（§2.4 已把 `bidAskRatio`/`bidCount` 的池化 AUC 高判成量纲假象）。
const CONDITIONS = [
  {
    key: "bidRatio",
    label: "求购厚度 / 自身168h均值",
    hypothesis: "求购盘越厚（相对自身常态）、未来 7 天越好",
    direction: +1,
    note: "§2.3 在标注口径下 15/16、p=0.0003；这里换成 T+7 自动标签重测",
    bands: [
      ["<0.7（异常薄）", -Infinity, 0.7],
      ["0.7~0.9", 0.7, 0.9],
      ["0.9~1.1（常态）", 0.9, 1.1],
      ["1.1~1.3", 1.1, 1.3],
      ["1.3~1.6", 1.3, 1.6],
      ["1.6~2.0", 1.6, 2.0],
      [">2.0（异常厚）", 2.0, Infinity],
    ],
  },
  {
    key: "bidAskRatioRel",
    label: "买卖盘厚度比 / 自身基线",
    hypothesis: "买盘相对卖盘变厚、未来 7 天越好",
    direction: +1,
    note: "§2.3 在标注口径下 14/16、p=0.0021",
    bands: [
      ["<0.7", -Infinity, 0.7],
      ["0.7~0.9", 0.7, 0.9],
      ["0.9~1.1", 0.9, 1.1],
      ["1.1~1.3", 1.1, 1.3],
      ["1.3~1.6", 1.3, 1.6],
      ["1.6~2.0", 1.6, 2.0],
      [">2.0", 2.0, Infinity],
    ],
  },
  {
    key: "bidCountChg24h",
    label: "求购数 24h 变化率",
    hypothesis: "买盘正在变厚（而不是已经厚）、未来 7 天越好",
    direction: +1,
    note: "§2.4 在标注口径下 11/16、p=0.1662，是阴性偏弱的一条，留作对照",
    bands: [
      ["<−20%", -Infinity, -0.2],
      ["−20~−5%", -0.2, -0.05],
      ["−5~+5%（平）", -0.05, 0.05],
      ["+5~20%", 0.05, 0.2],
      ["+20~50%", 0.2, 0.5],
      [">+50%", 0.5, Infinity],
    ],
  },
  {
    key: "bidSpread",
    label: "买卖价差",
    hypothesis: "价差收窄 = 有人在下方堆买单",
    direction: -1,
    note: "§2.4 已在标注口径下证伪（9/16、p=0.402）。**这里是阴性对照**，不是候选",
    bands: [
      ["<0%（求购高于在售）", -Infinity, 0],
      ["0~2%", 0, 0.02],
      ["2~5%", 0.02, 0.05],
      ["5~10%", 0.05, 0.1],
      [">10%", 0.1, Infinity],
    ],
  },
];

// ============================================================================
// 工具（跟 build-t7-entry-baseline.mjs 同一份实现）
// ============================================================================
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const fmt = (v) =>
  Number.isNaN(v) || v === undefined ? "   -   " : (v * 100).toFixed(2).padStart(6) + "%";

function signTestP(hits, total) {
  if (!total) return NaN;
  const logC = (n, k) => {
    let s = 0;
    for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1);
    return s;
  };
  let logSum = -Infinity;
  for (let i = hits; i <= total; i++) {
    const l = logC(total, i);
    logSum =
      logSum === -Infinity ? l : Math.max(logSum, l) + Math.log(1 + Math.exp(-Math.abs(logSum - l)));
  }
  return Math.exp(logSum - total * Math.log(2));
}

function auc(scores, labels) {
  const idx = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  const pos = labels.filter((l) => l === 1).length;
  const neg = labels.length - pos;
  if (!pos || !neg) return NaN;
  let rankSum = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (idx[k][1] === 1) rankSum += avgRank;
    i = j;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

// ============================================================================
// 基准
// ============================================================================
assertBaselineTable(db);
const baselineRows = loadBaseline(db, HORIZON_DAYS);
if (baselineRows.size === 0) {
  console.log("market_baseline_daily 里还没有基准，先跑：node scripts/build-market-baseline.mjs");
  process.exit(0);
}
console.log(baselineProvenance(db));
console.log("");
const marketByDay = new Map([...baselineRows.entries()].map(([day, v]) => [day, v.median]));

// ============================================================================
// 建样本
// ============================================================================
const items = db
  .prepare(
    `SELECT DISTINCT item_name FROM price_snapshots
     WHERE bidding_count IS NOT NULL AND price > 0 AND captured_at >= ?`
  )
  .all(BIDDING_DATA_START)
  .map((r) => r.item_name);

const perItemDaily = new Map(); // item -> day -> 样本
const platformsUsed = new Map(); // platform -> 用了几个饰品
let itemsUsed = 0;
let skippedShort = 0;
let skippedGap = 0;
const missingBaselineByDay = new Map();
const candidateDays = new Set();

for (const item of items) {
  const platform = biddingPlatform(db, item);
  if (!platform) continue;
  const series = biddingHourlySeries(db, item, platform);
  if (series.length < HISTORY_GATE_HOURS) {
    skippedShort += 1;
    continue;
  }
  itemsUsed += 1;
  platformsUsed.set(platform, (platformsUsed.get(platform) ?? 0) + 1);

  const pre = precomputeSeries(series);
  const hourIndex = new Map(series.map(([h], i) => [h, i]));
  const byDay = new Map();

  for (let i = 24; i < series.length; i++) {
    const [ts, row] = series[i];
    const price = row.price;
    if (!(price > 0)) continue;
    if (sinceMs !== null && ts < sinceMs) continue;

    // 前瞻收益：必须**正好** 7×24 小时之后有价，不做就近取值——就近会让持有期忽长忽短
    const futureIdx = hourIndex.get(ts + HORIZON_DAYS * DAY_MS);
    if (futureIdx === undefined) {
      skippedGap += 1;
      continue;
    }
    const futurePrice = series[futureIdx][1].price;
    if (!(futurePrice > 0)) continue;
    const fwd = (futurePrice - price) / price;
    if (!Number.isFinite(fwd)) continue;

    const day = Math.floor(ts / DAY_MS) * DAY_MS;
    candidateDays.add(day);
    const base = marketByDay.get(day);
    if (base === undefined || Number.isNaN(base)) {
      const key = new Date(day).toISOString().slice(0, 10);
      missingBaselineByDay.set(key, (missingBaselineByDay.get(key) ?? 0) + 1);
      continue;
    }

    // 口径第 1 条：同一饰品同一天只留一个样本。first = 当天最早那个合格小时桶。
    const existing = byDay.get(day);
    if (existing) {
      if (hourPick === "first") continue;
      const noonMs = day + 12 * HOUR_MS;
      if (Math.abs(existing.ts - noonMs) <= Math.abs(ts - noonMs)) continue;
    }
    byDay.set(day, {
      ts,
      fwd,
      excess: fwd - base,
      feat: computeBiddingFeatures(series, i, pre),
    });
  }
  if (byDay.size) perItemDaily.set(item, byDay);
}

assertBaselineCoverage(db, HORIZON_DAYS, [...candidateDays]);

const allSamples = [];
for (const [item, byDay] of perItemDaily) {
  for (const [, s] of byDay) allSamples.push({ item, ...s });
}

console.log("=== 样本 ===");
console.log(`求购数据起始 ${BIDDING_DATA_START}（此前的行没有这两个字段）`);
console.log(
  `有求购数据的饰品 ${items.length} 个；历史 ≥${HISTORY_GATE_HOURS} 小时的 ${itemsUsed} 个` +
    `（因历史太短跳过 ${skippedShort} 个）`
);
console.log(
  `参考平台构成：${[...platformsUsed.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p} ${n}`)
    .join(" / ")}` + "  ← 平台集合变了这张表就得重看（第四节 0.6）"
);
console.log(
  `去重后样本 ${allSamples.length} 条 / ${perItemDaily.size} 个饰品；` +
    `T+7 那一格没有价而丢弃 ${skippedGap} 条`
);
if (missingBaselineByDay.size) {
  const days = [...missingBaselineByDay.entries()].sort();
  const total = days.reduce((s, [, n]) => s + n, 0);
  console.log(
    `⚠️ 缺基准丢弃 ${total} 条，落在 ${days.length} 天：` +
      days
        .slice(0, 10)
        .map(([d, n]) => `${d}(${n})`)
        .join(" ") +
      (days.length > 10 ? " …" : "")
  );
  console.log("   缺口集中在最新那几天是**预期内的**（7 天窗口要到 day+7+6h 才定型）。");
}
console.log("");

if (!allSamples.length) {
  console.log("没有可用样本，到此为止。");
  process.exit(0);
}

// ============================================================================
// 分档表
// ============================================================================
console.log(`成本线：往返 ${(COST.min * 100).toFixed(1)}% ~ ${(COST.target * 100).toFixed(1)}%`);
console.log(
  "**录取判据：绝对收益中位数 ≥ 成本线下界，且超额中位数 > 0。** " +
    "只过超额那条的含义是「跌得比大盘少」，那不是买点。"
);
console.log("");

const verdicts = [];

for (const cond of CONDITIONS) {
  console.log(`### ${cond.label}（${cond.key}）`);
  console.log(`假设：${cond.hypothesis}`);
  console.log(`备注：${cond.note}`);
  console.log("");
  console.log(
    "档位                  | 样本 | 饰品 | 绝对中位 | 超额中位 | 绝对为正的品 | 符号p  | 够成本线"
  );
  console.log(
    "----------------------|------|------|----------|----------|--------------|--------|--------"
  );

  let best = null;
  for (const [label, lo, hi] of cond.bands) {
    const inBand = allSamples.filter((s) => {
      const v = s.feat[cond.key];
      return v >= lo && v < hi;
    });
    if (!inBand.length) {
      console.log(`${label.padEnd(21)} |    0 |    0 |     -    |     -    |       -      |    -   |   -`);
      continue;
    }
    const byItem = new Map();
    for (const s of inBand) {
      if (!byItem.has(s.item)) byItem.set(s.item, []);
      byItem.get(s.item).push(s);
    }
    // 一个饰品至少 MIN_DAYS_PER_ITEM 天才算一票，挡住"一天定一票"
    const voters = [...byItem.entries()].filter(([, v]) => v.length >= MIN_DAYS_PER_ITEM);
    const posItems = voters.filter(([, v]) => median(v.map((x) => x.fwd)) > 0).length;
    const absMed = median(inBand.map((s) => s.fwd));
    const excMed = median(inBand.map((s) => s.excess));
    const p = signTestP(posItems, voters.length);
    const passes = absMed >= COST.min && excMed > 0;
    if (passes && (!best || absMed > best.absMed)) best = { label, absMed, excMed };
    console.log(
      `${label.padEnd(21)} | ${String(inBand.length).padStart(4)} | ${String(byItem.size).padStart(4)} | ` +
        `${fmt(absMed)} | ${fmt(excMed)} | ${String(posItems).padStart(5)}/${String(voters.length).padEnd(6)} | ` +
        `${Number.isNaN(p) ? "  -   " : p.toFixed(4)} | ${passes ? "✅ 是" : "否"}`
    );
  }

  // AUC 只用于淘汰
  const scores = allSamples.map((s) => cond.direction * s.feat[cond.key]);
  const labels = allSamples.map((s) => (s.excess > 0 ? 1 : 0));
  const a = auc(scores, labels);
  const eliminated = !Number.isNaN(a) && a < AUC_ELIMINATION_FLOOR;
  console.log("");
  console.log(
    `池化 AUC（按假设方向，超额为正当正类）= ${a.toFixed(3)}` +
      `${eliminated ? ` < ${AUC_ELIMINATION_FLOOR} ⇒ **淘汰**（连排序信息都没有）` : "（过了下限不构成任何录取理由）"}`
  );
  verdicts.push({ cond, best, auc: a, eliminated });
  console.log("");
}

// ============================================================================
// 结论
// ============================================================================
console.log("=== 结论 ===");
const admitted = verdicts.filter((v) => v.best && !v.eliminated);
if (!admitted.length) {
  console.log(
    "**没有任何一档同时满足「绝对收益中位数 ≥ 成本线」和「超额中位数 > 0」。**"
  );
  console.log(
    "按 HYPOTHESES §2.4 对买入侧价格特征的处理方式，这意味着求购深度在 T+7 口径下" +
      "**也没有产出可行动的买点**——注意这跟「它区分不出操盘期」是两件事：" +
      "标注口径下 bidRatio 的方向性依然成立（见 analyze-bidding-depth-features.mjs），" +
      "**排序能力 ≠ 幅度**（踩坑 46）。"
  );
} else {
  for (const v of admitted) {
    console.log(
      `· ${v.cond.label} 的「${v.best.label}」档：绝对 ${fmt(v.best.absMed)}、超额 ${fmt(v.best.excMed)} ⇒ 够成本线`
    );
  }
  console.log("");
  console.log(
    "⚠️ **够成本线不等于可以上线。**按三关（HYPOTHESES §4.2）还要过：" +
      "① 独立性（跟已有信号是不是同一个量的另一种表述）；② 影子并行记录一段时间；" +
      "③ 预先声明的复核口径。**不要拿这张表直接改规则。**"
  );
}
