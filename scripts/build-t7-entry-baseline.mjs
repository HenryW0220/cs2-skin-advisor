// 买入侧：可观测入场条件的 T+7 净收益分档表。
// 用法：node scripts/build-t7-entry-baseline.mjs [库文件] [--since YYYY-MM-DD] [--hour-pick first|noon]
//
// ============================================================================
// 一、为什么换标签（2026-08-15 项目所有者决定）
// ============================================================================
// C1/C2 那条线的终点结论是**模型分不清"操盘"和"外部事件"**（REPORT-prediction-baseline.md
// 问题 3）。那不是特征不够好，是**标签定义不良**：操盘不可观测，我们只能用价格特征去识别
// 一个只能用价格特征识别的东西，循环里没有新信息进来。而唯一通过经济显著性门槛的结论
// （v2 的 >30% 档，超额 −18.69%）是从 714 饰品的**价格数据**反推的，一条人工标注都没用到。
//
// 所以买入侧改用**自动生成的标签**：此刻买入、锁 7 天、第 7 天卖出的收益。
// 这跟卖出侧 v2 是同一套方法论（分档 + 超额 + 成本线 + 按饰品符号检验），已经验证过
// 能产出可用结论。人工标注从训练输入降级为**事后解释性检查**，不再是前置依赖。
//
// T+7 不是随便选的窗口：2026-07-15 交易保护新规后买入锁 7 天才能卖（PLAN.md 原则 6），
// 所以"买入后第 7 天的收益"就是买入侧唯一能变成钱的量，不是一个可调的超参。
// **不要因为某个档位不够成本线就去试 14 天 / 30 天窗口**——那正是 HANDOFF ② 预先封口的
// 那类动作（把窗口长度变成可搜的超参）。要重开必须有新数据源，不是新窗口。
//
// ============================================================================
// 二、只回答一个问题
// ============================================================================
// **有没有任何一个可观测的入场条件，其 T+7 收益的中位数能覆盖 6.7%~12% 的往返成本？**
//
// 不是"模型能不能打赢基准"。打赢一个负收益基准不代表能赚钱——RSI 那次就是方向对、
// p=0.0000、幅度差一个数量级（+0.61% vs 6.7%）。判据从一开始就是成本线，不是显著性。
//
// **先做单条件分档，不上模型**：模型会把"哪个条件有用"藏进权重里，而我们要的恰恰是
// 那张能直接读的分档表。
//
// ============================================================================
// 三、口径（预先钉死，这一节比上面两节重要）
// ============================================================================
// 上一版 T+7 报告（REPORT-t7-actionable-labels.md）的数字是 +41.6%，去掉贡献最大的 5 个
// 饰品后掉到 +7.67%。这次按现在的规范重做，不是复用那份脚本。六条：
//
// 1. **按饰品去重**：同一饰品同一天只取一个样本（见 DEDUPE 那一段）。上一版那个 bug
//    （top-5 被同一饰品的不同小时占满）不能重演。
// 2. **只报中位数，不报均值**：均值在这份数据上已经被证明会被孤例主导（踩坑 44 ①）。
// 3. **每一档同时给**：可评估样本数、有该档的饰品数、中位数为正/为负的饰品数、符号检验 p。
//    表结构跟 build-sell-rule-baseline.mjs 一致，便于并排比较。
// 4. **AUC 只用于淘汰，不用于录取**（踩坑 46）。见 AUC_ELIMINATION_FLOOR 那段的推导。
// 5. **régime**：见 --since 那段。
// 6. **绝对收益和超额都要报**（这一条是写脚本时补的，理由在下面）。
//
// ---- 关于第 6 条：成本线是用现金付的，超额不是现金 ----
// 项目所有者的原话是"超额收益的中位数能覆盖 6.7%~12% 的往返成本"。**但这两个量不同质**：
// 大盘跌 10% 而这个饰品只跌 2% 时，超额是 +8%、现金是 −2%——**拿不出钱付手续费**。
// 反过来只看绝对收益又会把 beta 当成信号（踩坑 44 ②，卖出侧就是为此才改的超额口径）。
// 所以两列都出，**录取判据写死成：绝对收益中位数 ≥ 成本线，且超额中位数 > 0**。
// 只过超额那条的档位含义是"跌得比大盘少"，那不是买点。
//
// ---- ⚠️ 但**不要**把这条判据套到卖出侧去（2026-08-15 项目所有者确认）----
// `build-sell-rule-baseline.mjs` 整张表是**纯超额**口径，v2 的全部阈值（>30% 档 −18.69%）
// 都是这么反推的。**那是对的，不受这条新判据影响**——两侧的正确口径本来就不同，
// **这不是不一致，是标的不同**：
//
//   · **卖出侧决定的是"换不换手"**。两个选项（现在卖 / 继续持有）**持有同一份资产**，
//     大盘涨跌对双方一样、在差额上抵消 ⇒ 超额本来就是对的比较基准。
//   · **买入侧决定的是"要不要动用现金"**。对照物是**现金**不是市场 ⇒ 必须看绝对值。
//
// **判之前先问一句：这个决策的对照物是同一份资产，还是现金？**
// 这条以后每次有人做新分档都会踩，而且踩了不报错——2026-08-15 实测，买入侧十几个档位是
// "超额为正、绝对为零"，只按超额判的话它们全都会被误读成买点。
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { assertBaselineTable, baselineProvenance, loadBaseline } from "./market-baseline-store.mjs";
import { parseScriptArgs, resolveDbPath } from "./script-args.mjs";

// ---- --since：régime 边界（口径第 5 条）----
// `report-regime-boundaries.mjs` 查出 **2026-04 那批台阶和 5~6 月平台数在 1↔5 之间反复跳，
// 至今没有对应的已知配置变更**，而规范四点五 #4 写死了"没查清之前，任何跨越 2026-07 之前的
// 聚合都不要用"。平台数直接决定每个饰品的参考平台，也就直接决定这里算的每一个收益。
//
// 所以本脚本的**主口径是 --since 2026-07-01**（单一 régime，7 月那几条边界都是已解释的
// 变更：候选池回填、迁云端、C5 提频、OOM 崩溃循环，没有一条改变单个饰品的价格语义）。
// 不带 --since 的全区间跑法**只能当参照**，报告里必须标注它跨越了未解释的 régime。
//
// **两次跑法是预先声明的，不是跑完挑好看的那个。** 全区间那次只看方向是否一致，
// 幅度和 p 值不作数。
const args = parseScriptArgs({
  name: "build-t7-entry-baseline",
  usage: "node scripts/build-t7-entry-baseline.mjs [库文件] [--since YYYY-MM-DD] [--hour-pick first|noon]",
  values: {
    "--since": { parse: String, default: "", label: "只用这个日期之后的样本" },
    // 去重规则的稳健性检查，同样是预先声明的一对：first 是主口径，noon 只用来确认
    // "结论不是被取哪个小时决定的"。**只看方向，不看幅度。**
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
// 下面这四个常量必须跟 market-baseline-store.mjs / build-sell-rule-baseline.mjs 完全一致：
// 参与统计的饰品集合一变，基准和超额就都变了（迁移 024 的注释里已经栽过一次）。
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const MIN_SNAPSHOTS_PER_ITEM = 200;
const HORIZON_DAYS = 7; // T+7 锁定期，不是可调窗口，见文件头
const HISTORY_GATE_HOURS = 24 * (HORIZON_DAYS + 14);

// 特征回看窗口
const MA_WINDOW_HOURS = 168; // 7 天均线，跟 lib/signals 的小时桶口径一致（踩坑 45）
const DRAWDOWN_WINDOW_HOURS = 48; // 跟 lib/signals/washout.ts 的 DEFAULT_WINDOW_HOURS 一致
const WASHOUT_DRAWDOWN = 0.15; // 跟 lib/signals/washout.ts 的 DEFAULT_DRAWDOWN_THRESHOLD 一致

// 符号检验里，一个饰品至少要有这么多天的样本才算一票。
// **为什么是 2 而不是 build-sell-rule-baseline 的 12**：那边一个饰品一天有 24 个小时样本，
// 12 就是"至少半天"；这边去重之后一个饰品一天最多一个样本，12 等于要求半个月连续命中，
// 尾部档位会被清空——而尾部正是这份表要回答的全部问题。取 2 是为了挡住"一天定一票"，
// 再高就是在用门槛挑样本了。每档会打印被这条门槛剔掉多少个饰品。
const MIN_DAYS_PER_ITEM = 2;

// ---- AUC 淘汰下限（口径第 4 条）----
// **只淘汰，不录取。** 理由（踩坑 46）：AUC 衡量全域排序能力，而这里全部价值都在尾部——
// 阳性对照 return24h 按饰品 AUC 中位数 0.567，被判死刑的 RSI 是 0.578，**已上线的那个比
// 被否掉的这个还低**。拿它当录取标准会同时放进 RSI、否掉 return24h。
//
// 下限只能定在"连排序信息都没有"这条线上，而这条线有已知量可依：
//   · 阴性对照 volumeRatio（两条独立路径确认的死信号）按饰品 AUC 中位数 **0.470**；
//   · 阳性对照 return24h **0.567**、已否决的 RSI **0.578** —— 两者都在 0.5 以上，
//     这正是"过了下限什么都不说明"的实证。
// 所以下限取 **0.50**：低于它说明该特征在假设的方向上连抛硬币都不如，直接出局；
// 高于它不构成任何录取理由。**不要因为想让某个特征通过就把这个数往上调**——
// 往上调会同时淘汰掉唯一赚得到钱的那个。
const AUC_ELIMINATION_FLOOR = 0.5;

// ---- 成本线：不写死，从 lib/rules/cost-line.ts 读，读不到就硬失败 ----
// 手抄一份迟早跟生产漂开，而漂开之后这份报告的每一条"够/不够成本线"都是错的且不报错。
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
// 四个候选条件都是**已有的、可观测的**，不引入新数据源：
//   · drawdown48h —— 唯一在三份独立报告里都稳定出现的正权重特征
//     （REPORT-t7-actionable-labels.md 结论 2、REPORT-prediction-baseline.md、
//      REPORT-manipulation-playbook-stages.md 的洗盘指纹）
//   · return24h —— 卖出侧 v2 的核心信号，这里看它的**另一侧**（卖出侧尾部有台阶，
//     买入侧那一端有没有）。它同时是本表的阳性对照。
//   · return7d  —— 同一个反转假设换个尺度。边界故意跟 24h 用同一套，两张表才能并排读。
//   · maDev     —— 偏离均线。**用带符号的**：绝对值会把"远高于均线"和"远低于均线"
//     混成一档，而买入侧问的恰恰是低于均线那一侧（老脚本用的是 Math.abs，这里是有意改的）。
const CONDITIONS = [
  {
    key: "drawdown48h",
    label: "48h 回撤",
    hypothesis: "回撤越深、未来 7 天越好（洗盘后反弹）",
    direction: +1, // AUC 按 +feature 算
    note: `回撤 = (48 小时内最高价 − 当前价) / 最高价，${WASHOUT_DRAWDOWN * 100}% 以上是 washout.ts 的洗盘线`,
    bands: [
      ["<2%（贴顶）", -Infinity, 0.02],
      ["2~5%", 0.02, 0.05],
      ["5~10%", 0.05, 0.1],
      ["10~15%", 0.1, 0.15],
      ["15~20%", 0.15, 0.2],
      ["20~30%", 0.2, 0.3],
      [">30%", 0.3, Infinity],
    ],
  },
  {
    key: "return24h",
    label: "24h 涨跌",
    hypothesis: "跌得越多、未来 7 天越好（短期反转）",
    direction: -1,
    note: "卖出侧 v2 的同一个量，这里看下跌那一侧；同时是本表的阳性对照",
    bands: [
      ["<−30%", -Infinity, -0.3],
      ["−30~−20%", -0.3, -0.2],
      ["−20~−15%", -0.2, -0.15],
      ["−15~−10%", -0.15, -0.1],
      ["−10~−5%", -0.1, -0.05],
      ["−5~0%", -0.05, 0],
      ["0~5%", 0, 0.05],
      ["5~15%", 0.05, 0.15],
      [">15%", 0.15, Infinity],
    ],
  },
  {
    key: "return7d",
    label: "7d 涨跌",
    hypothesis: "同上，换 7 天尺度",
    direction: -1,
    note: "边界故意跟 24h 用同一套，两张表可以并排读（7 天的振幅天然更大，尾部档会更满）",
    bands: [
      ["<−30%", -Infinity, -0.3],
      ["−30~−20%", -0.3, -0.2],
      ["−20~−15%", -0.2, -0.15],
      ["−15~−10%", -0.15, -0.1],
      ["−10~−5%", -0.1, -0.05],
      ["−5~0%", -0.05, 0],
      ["0~5%", 0, 0.05],
      ["5~15%", 0.05, 0.15],
      [">15%", 0.15, Infinity],
    ],
  },
  {
    key: "maDev",
    label: "偏离 7d 均线",
    hypothesis: "低于均线越多、未来 7 天越好（均值回归）",
    direction: -1,
    note: "带符号（老脚本用的是绝对值，会把高于/低于均线混成一档）",
    bands: [
      ["<−20%", -Infinity, -0.2],
      ["−20~−10%", -0.2, -0.1],
      ["−10~−5%", -0.1, -0.05],
      ["−5~0%", -0.05, 0],
      ["0~5%", 0, 0.05],
      ["5~10%", 0.05, 0.1],
      ["10~20%", 0.1, 0.2],
      [">20%", 0.2, Infinity],
    ],
  },
];

// 组合只做两个，**跟 v2 的否决条款同源**（深回撤 + 低涨幅时 v2 明确不卖，
// 那条的镜像就是买入侧的候选）。**故意不做全部两两组合**：组合数一多就变成在搜，
// 而且每多一个都要进下面那个 Bonferroni 分母。
const COMBOS = [
  {
    label: `洗盘态（回撤>${WASHOUT_DRAWDOWN * 100}%）且 24h 涨幅<5%`,
    test: (f) => f.drawdown48h > WASHOUT_DRAWDOWN && f.return24h < 0.05,
  },
  {
    label: "深回撤（回撤>30%）且 24h 涨幅<5%",
    test: (f) => f.drawdown48h > 0.3 && f.return24h < 0.05,
  },
];

// ---- 预先声明的独立性检验（2026-08-15，项目所有者声明后执行）----
// **一次检验，不是一组。** 跑完不换边界、不换分层变量。
//
// 背景：本表在卖出侧摔出一条 maDev > +20%，三个跑法绝对收益中位 −19.04%/−18.92%/−13.37%，
// 比 v2 在用的 return24h > 15%（−12.85%）还狠 6pp。但两个量高度相关（一次大涨会同时把价格
// 顶到均线之上），所以在验证独立性之前不许接进 sell-rule-v2.ts。
//
// **唯一的切法**：在 `return24h < 15%` 的样本里单独看 `maDev > +20%` 的 T+7 超额。
//   · 台阶还在（幅度仍显著、饰品数够）→ 不只是 return24h 的另一种表述，作为独立候选进影子
//     并行，跟 v2 现有档位并列记录，**不改任何现有阈值**。
//   · 台阶消失 → 它就是 return24h 的更好表述。**这也是有用的结论**：写进报告说明为什么不加，
//     以后别人再看到 −19% 不会重新兴奋一次。
//
// ⚠️ **这一格按纯超额口径判，不套买入侧那条"绝对 ≥ 成本线"的新判据**——理由见文件头
// 「两侧口径本来就不同」那一段：它测的是卖出侧，比的是换不换手，对照物是同一份资产。
const INDEPENDENCE_TEST = {
  label: "maDev > +20% 且 24h 涨幅 < 15%",
  reference: "maDev > +20%（不设条件，即主表那一行）",
  test: (f) => f.maDev > 0.2 && f.return24h < 0.15,
  refTest: (f) => f.maDev > 0.2,
};

// ============================================================================
// 取数：口径跟 market-baseline-store.mjs 逐条对齐
// ============================================================================
function referencePlatform(itemName) {
  const rows = db
    .prepare(
      `SELECT platform, COUNT(*) n FROM price_snapshots
       WHERE item_name = ? AND price > 0 GROUP BY platform ORDER BY n DESC`
    )
    .all(itemName);
  for (const p of PLATFORM_PRIORITY) {
    const hit = rows.find((r) => r.platform === p);
    if (hit && hit.n >= MIN_SNAPSHOTS_PER_ITEM) return p;
  }
  return rows[0]?.n >= MIN_SNAPSHOTS_PER_ITEM ? rows[0].platform : null;
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

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const fmt = (v) => (Number.isNaN(v) || v === undefined ? "   -   " : (v * 100).toFixed(2).padStart(6) + "%");
const bandOf = (bands, v) => bands.find(([, lo, hi]) => v >= lo && v < hi)?.[0] ?? null;

/** 按**时间戳**取价，缺这一格就返回 null（不做就近取值，见下面 skippedGap 那段注释）。 */
function priceAt(hourIndex, series, targetMs) {
  const idx = hourIndex.get(targetMs);
  if (idx === undefined) return null;
  const p = series[idx][1];
  return p > 0 ? p : null;
}

/** 单边符号检验：P(X ≥ hits)，X ~ B(total, 0.5)。跟 build-sell-rule-baseline.mjs 同一份实现。 */
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
    logSum = logSum === -Infinity ? l : Math.max(logSum, l) + Math.log(1 + Math.exp(-Math.abs(logSum - l)));
  }
  return Math.exp(logSum - total * Math.log(2));
}

/** 秩和法算 AUC：score 越大越该是正类。两类之一为空时返回 NaN。 */
function auc(scores, labels) {
  const idx = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  const pos = labels.filter((l) => l === 1).length;
  const neg = labels.length - pos;
  if (!pos || !neg) return NaN;
  let rankSum = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const avgRank = (i + 1 + j) / 2; // 并列取平均秩
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
const items = db.prepare("SELECT DISTINCT item_name FROM price_snapshots").all().map((r) => r.item_name);

// item -> day -> 该天选中的那一个样本（口径第 1 条：按饰品去重）
//
// **取哪个小时是预先定死的，跟结果无关**：hour-pick=first 取当天最早那个合格小时桶。
// 这条必须与结果无关——按"回撤最深的那个小时"或"收益最好的那个小时"去重，就是在每天
// 挑一次最优点，那正是上一版 +41.6% 的病根（同一饰品的不同小时占满 top-5）。
// 代价是当天晚些时候才出现的条件会被漏掉，这是**功效损失不是偏差**。
const perItemDaily = new Map();
let itemsUsed = 0;
let rawSamples = 0;
let skippedGap = 0;
const missingBaselineByDay = new Map();

for (const item of items) {
  const platform = referencePlatform(item);
  if (!platform) continue;
  const series = hourlyPrices(item, platform);
  if (series.length < HISTORY_GATE_HOURS) continue;
  itemsUsed += 1;

  const hourIndex = new Map(series.map(([h], i) => [h, i]));
  const byDay = new Map();

  for (let i = MA_WINDOW_HOURS; i < series.length; i++) {
    const [ts, price] = series[i];
    if (price <= 0) continue;
    if (sinceMs !== null && ts < sinceMs) continue;

    // 前瞻收益：必须**正好** 7×24 小时之后有价，不做就近取值——就近会让持有期忽长忽短
    const futureIdx = hourIndex.get(ts + HORIZON_DAYS * DAY_MS);
    if (futureIdx === undefined) continue;
    const fwd = (series[futureIdx][1] - price) / price;
    if (!Number.isFinite(fwd)) continue;

    const day = Math.floor(ts / DAY_MS) * DAY_MS;
    const base = marketByDay.get(day);
    if (base === undefined || Number.isNaN(base)) {
      // 护栏 (c)：缺基准的剔除要留痕到"哪一天"，别静默丢弃。
      // 缺口永远落在最新那几天（7 天窗口要到 day+7+6h 才定型），是系统性的不是随机的。
      const k = new Date(day).toISOString().slice(0, 10);
      missingBaselineByDay.set(k, (missingBaselineByDay.get(k) ?? 0) + 1);
      continue;
    }

    // ---- 特征 ----
    // ⚠️ **回看一律按时间戳查，不按数组下标**。build-sell-rule-baseline.mjs 用的是
    // `series[i - 24]`，而这个序列是**按小时去重后的稀疏数组**——采集有缺口时（7-27~7-30
    // 那轮 OOM 崩溃循环、偶尔错过的整点同步），往回数 24 格可能落到 30 小时之前，
    // 于是"24h 涨跌"这个量的实际窗口会随缺口悄悄变长，而且不报错。
    // 前瞻那一侧本来就是按时间戳精确查的（`ts + 7*DAY_MS`），两侧不一致更没道理。
    // 这里改成两侧都按时间戳，缺格的样本直接跳过并计数（见 skippedGap）。
    const prev24 = priceAt(hourIndex, series, ts - 24 * HOUR_MS);
    const prev168 = priceAt(hourIndex, series, ts - 168 * HOUR_MS);
    if (prev24 === null || prev168 === null) {
      skippedGap += 1;
      continue;
    }

    // 回撤窗口和均线窗口同样按**时间**框定，不按下标切片
    let peak = 0;
    for (let k = i; k >= 0 && series[k][0] >= ts - DRAWDOWN_WINDOW_HOURS * HOUR_MS; k--) {
      peak = Math.max(peak, series[k][1]);
    }
    // **当前回撤**（从 48 小时高点跌到现在），不是窗口内的最大回撤。
    // 这跟 build-sell-rule-baseline.mjs 的洗盘列一致，但**跟生产 lib/signals/washout.ts 不一致**——
    // 后者取的是窗口内任意时点的最大回撤（只要高点不是当前点就算数），于是"中途深跌但已经
    // 涨回高点附近"也会被判成洗盘态。买入侧问的是"现在是不是还在坑里"，所以用当前回撤。
    // 这个差异是查出来的，不是笔误，已写进报告。
    const drawdown48h = peak > 0 ? Math.max(0, (peak - price) / peak) : 0;

    let maSum = 0;
    let maCount = 0;
    for (let k = i - 1; k >= 0 && series[k][0] >= ts - MA_WINDOW_HOURS * HOUR_MS; k--) {
      maSum += series[k][1];
      maCount += 1;
    }
    // 均线至少要有窗口一半的桶才算数，否则缺口期算出来的"7 天均线"其实只用了一两天
    if (maCount < MA_WINDOW_HOURS / 2) {
      skippedGap += 1;
      continue;
    }
    const ma = maSum / maCount;

    const feats = {
      drawdown48h,
      return24h: (price - prev24) / prev24,
      return7d: (price - prev168) / prev168,
      maDev: ma > 0 ? (price - ma) / ma : 0,
    };

    rawSamples += 1;
    const sample = { ts, day, feats, fwd, excess: fwd - base };
    const cur = byDay.get(day);
    if (cur === undefined) {
      byDay.set(day, sample);
    } else if (hourPick === "noon") {
      // 稳健性检查用：取当天最接近 12:00 UTC 的那个小时，同样与结果无关
      const noon = day + 12 * HOUR_MS;
      if (Math.abs(ts - noon) < Math.abs(cur.ts - noon)) byDay.set(day, sample);
    }
    // hour-pick=first：第一个就是最早的（series 已按时间升序），后面的直接丢
  }

  if (byDay.size) perItemDaily.set(item, [...byDay.values()]);
}

const allSamples = [...perItemDaily.values()].flat();
const days = [...new Set(allSamples.map((s) => s.day))].sort();

console.log(`参与统计的饰品：${itemsUsed} 个（历史长度门槛 ${HISTORY_GATE_HOURS} 小时，跟基准口径一致）`);
console.log(
  `去重前小时级样本 ${rawSamples} 条 → 去重后 ${allSamples.length} 条（饰品-天），` +
    `涉及 ${perItemDaily.size} 个饰品 / ${days.length} 天` +
    (days.length ? `（${new Date(days[0]).toISOString().slice(0, 10)} ~ ${new Date(days[days.length - 1]).toISOString().slice(0, 10)}）` : "")
);
console.log(`去重规则：同一饰品同一天只取${hourPick === "first" ? "**当天最早**" : "**最接近 12:00 UTC**"}的那个小时桶`);
console.log(
  `因回看窗口缺格被跳过的小时级样本：${skippedGap} 条` +
    `（24h/7d 回看按时间戳精确查，采集有缺口时不做就近取值——` +
    `build-sell-rule-baseline.mjs 那边是按下标往回数的，缺口期窗口会悄悄变长）`
);
if (sinceDay) {
  console.log(`régime：样本已限制在 ${sinceDay} 之后（主口径，单一 régime）`);
} else {
  console.log(
    "⚠️ **全区间跑法**：这段样本跨越了 2026-04~06 那批**未解释**的 régime 台阶" +
      "（平台数 1↔5 反复跳，report-regime-boundaries.mjs 至今找不到对应的配置变更）。" +
      "按规范四点五 #4，这一次只能当参照、只看方向，**幅度和 p 值不作数**。"
  );
}
if (missingBaselineByDay.size) {
  const top = [...missingBaselineByDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(
    `缺大盘基准被剔除的小时级样本：${[...missingBaselineByDay.values()].reduce((a, b) => a + b, 0)} 条，` +
      `集中在 ${top.map(([d, n]) => `${d}(${n})`).join("、")}` +
      `${missingBaselineByDay.size > 5 ? ` 等 ${missingBaselineByDay.size} 天` : ""}`
  );
}
console.log("");
console.log(`成本线（读自 lib/rules/cost-line.ts）：下界 ${(COST.min * 100).toFixed(1)}% / 项目所有者口径 ${(COST.target * 100).toFixed(0)}%`);
console.log("");

if (allSamples.length === 0) {
  console.log("没有可评估样本，无事可做。");
  process.exit(0);
}

// ============================================================================
// 多重检验的分母：**先声明再看数字**
// ============================================================================
const TOTAL_TESTS = CONDITIONS.reduce((s, c) => s + c.bands.length, 0) + COMBOS.length;
const BONFERRONI_ALPHA = 0.05 / TOTAL_TESTS;
console.log(
  `本次一共检验 ${TOTAL_TESTS} 个档位（${CONDITIONS.map((c) => `${c.label} ${c.bands.length}`).join(" + ")} + 组合 ${COMBOS.length}），` +
    `Bonferroni α = ${BONFERRONI_ALPHA.toFixed(5)}`
);
console.log(
  "**p 不是录取判据**（录取判据是成本线），它只回答「这一档的方向是不是靠少数几个饰品拉出来的」。"
);
console.log("");

// ============================================================================
// 分档汇总
// ============================================================================
/** 一档的全部统计量。samples 是该档的 {item, sample} 列表。 */
function summarize(rows) {
  const excess = rows.map((r) => r.s.excess);
  const abs = rows.map((r) => r.s.fwd);
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.item)) byItem.set(r.item, []);
    byItem.get(r.item).push(r.s.excess);
  }
  let dropped = 0;
  const itemMedians = [];
  for (const [, vals] of byItem) {
    if (vals.length < MIN_DAYS_PER_ITEM) {
      dropped += 1;
      continue;
    }
    itemMedians.push(median(vals));
  }
  const pos = itemMedians.filter((v) => v > 0).length;
  const neg = itemMedians.filter((v) => v < 0).length;
  const n = itemMedians.length;
  // 报的是**观察到的那个方向**的单边 p，方向标在旁边。两边都报会让人挑一个小的。
  const p = n ? signTestP(Math.max(pos, neg), n) : NaN;
  const topShare = rows.length
    ? Math.max(...[...byItem.values()].map((v) => v.length)) / rows.length
    : NaN;
  return {
    n: rows.length,
    items: byItem.size,
    votedItems: n,
    dropped,
    pos,
    neg,
    p,
    dir: pos >= neg ? "正" : "负",
    medExcess: median(excess),
    medAbs: median(abs),
    medOfItemMedians: median(itemMedians),
    days: new Set(rows.map((r) => r.s.day)).size,
    topShare,
  };
}

/** 录取判据（口径第 6 条）：绝对收益中位数 ≥ 成本线下界，且超额中位数 > 0。 */
function verdict(st) {
  if (Number.isNaN(st.medAbs)) return "无样本";
  if (st.medAbs >= COST.target && st.medExcess > 0) return "✅ 过 12% 线";
  if (st.medAbs >= COST.min && st.medExcess > 0) return "🟡 过 6.7% 线";
  if (st.medExcess > 0 && st.medAbs > 0) return "✗ 正但不够成本";
  if (st.medExcess > 0) return "✗ 只赢大盘（现金亏）";
  return "✗";
}

function printBandTable(title, note, rowsByBand, bandLabels) {
  console.log(`=== ${title} ===`);
  if (note) console.log(`（${note}）`);
  console.log(
    "档位          | 可评估 | 饰品数 | 计票 | 中位为正 | 中位为负 | 绝对收益中位 | 超额中位 | 饰品中位数的中位 | 符号p  | 覆盖天 | 最大单品占比 | 判定"
  );
  console.log(
    "--------------|--------|--------|------|----------|----------|--------------|----------|------------------|--------|--------|--------------|------"
  );
  for (const label of bandLabels) {
    const rows = rowsByBand.get(label) ?? [];
    if (!rows.length) {
      console.log(`${label.padEnd(13)} | ${"0".padStart(6)} | ${"-".padStart(6)} | ${"-".padStart(4)} | ${"-".padStart(8)} | ${"-".padStart(8)} | ${"   -   ".padStart(12)} | ${"   -   ".padStart(8)} | ${"   -   ".padStart(16)} | ${"-".padStart(6)} | ${"-".padStart(6)} | ${"-".padStart(12)} | 无样本`);
      continue;
    }
    const st = summarize(rows);
    const pStr = Number.isNaN(st.p) ? "  -   " : st.p.toFixed(4);
    const star = !Number.isNaN(st.p) && st.p < BONFERRONI_ALPHA ? "*" : " ";
    console.log(
      `${label.padEnd(13)} | ${String(st.n).padStart(6)} | ${String(st.items).padStart(6)} | ` +
        `${String(st.votedItems).padStart(4)} | ${String(st.pos).padStart(8)} | ${String(st.neg).padStart(8)} | ` +
        `${fmt(st.medAbs).padStart(12)} | ${fmt(st.medExcess).padStart(8)} | ${fmt(st.medOfItemMedians).padStart(16)} | ` +
        `${pStr}${star}| ${String(st.days).padStart(6)} | ${(st.topShare * 100).toFixed(1).padStart(11)}% | ${verdict(st)}`
    );
  }
  console.log("");
}

for (const cond of CONDITIONS) {
  const rowsByBand = new Map(cond.bands.map(([l]) => [l, []]));
  for (const [item, samples] of perItemDaily) {
    for (const s of samples) {
      const label = bandOf(cond.bands, s.feats[cond.key]);
      if (label) rowsByBand.get(label).push({ item, s });
    }
  }
  printBandTable(
    `${cond.label}（${cond.key}）分档`,
    `${cond.note}｜假设：${cond.hypothesis}`,
    rowsByBand,
    cond.bands.map(([l]) => l)
  );
}

// ---- 组合 ----
{
  const rowsByBand = new Map(COMBOS.map((c) => [c.label, []]));
  for (const [item, samples] of perItemDaily) {
    for (const s of samples) {
      for (const c of COMBOS) if (c.test(s.feats)) rowsByBand.get(c.label).push({ item, s });
    }
  }
  printBandTable(
    "组合条件",
    "只做两个，跟 v2 的否决条款同源；组合数一多就是在搜",
    rowsByBand,
    COMBOS.map((c) => c.label)
  );
}

// ---- 预先声明的独立性检验（卖出侧，纯超额口径）----
{
  const rowsByBand = new Map([
    [INDEPENDENCE_TEST.reference, []],
    [INDEPENDENCE_TEST.label, []],
  ]);
  for (const [item, samples] of perItemDaily) {
    for (const s of samples) {
      if (INDEPENDENCE_TEST.refTest(s.feats)) rowsByBand.get(INDEPENDENCE_TEST.reference).push({ item, s });
      if (INDEPENDENCE_TEST.test(s.feats)) rowsByBand.get(INDEPENDENCE_TEST.label).push({ item, s });
    }
  }
  console.log("=== 预先声明的独立性检验：maDev>+20% 是不是只是 return24h 的另一种表述 ===");
  console.log(
    "**这是卖出侧，按纯超额口径读**（比的是换不换手，两个选项持有同一份资产，大盘涨跌对双方一样）。" +
      "买入侧那条「绝对 ≥ 成本线」的判据在这里不适用，所以「判定」列不作数，看「超额中位」。"
  );
  printBandTable(
    "",
    "一次检验不是一组：只此一种切法，跑完不换边界、不换分层变量",
    rowsByBand,
    [INDEPENDENCE_TEST.reference, INDEPENDENCE_TEST.label]
  );
}

// ============================================================================
// AUC：只用于淘汰
// ============================================================================
console.log("=== 按饰品 AUC（只用于淘汰，不用于录取）===");
console.log(
  `标签 = 该样本超额 > 0；按各特征的假设方向取号；每个饰品至少 20 个样本且两类都有才算。` +
    `淘汰下限 ${AUC_ELIMINATION_FLOOR.toFixed(2)}（推导见脚本常量注释）。`
);
console.log("特征           | 可算 AUC 的饰品数 | AUC 中位数 | 判定");
console.log("---------------|------------------|-----------|------");
for (const cond of CONDITIONS) {
  const aucs = [];
  for (const [, samples] of perItemDaily) {
    if (samples.length < 20) continue;
    const scores = samples.map((s) => cond.direction * s.feats[cond.key]);
    const labels = samples.map((s) => (s.excess > 0 ? 1 : 0));
    const a = auc(scores, labels);
    if (!Number.isNaN(a)) aucs.push(a);
  }
  const m = median(aucs);
  const out = Number.isNaN(m) ? "样本不足" : m <= AUC_ELIMINATION_FLOOR ? "✗ 出局" : "· 过下限（不说明任何事）";
  console.log(
    `${cond.label.padEnd(14)} | ${String(aucs.length).padStart(16)} | ${Number.isNaN(m) ? "    -    " : m.toFixed(3).padStart(9)} | ${out}`
  );
}
console.log("");

// ============================================================================
// 读法
// ============================================================================
console.log("读法（按这个顺序，别跳）：");
console.log(`  1. 先看"判定"列。只有 ✅/🟡 才是候选——判据是**绝对收益中位数**够不够 ${(COST.min * 100).toFixed(1)}%，`);
console.log("     不是超额、不是 p 值。超额那一列只用来区分「这是信号」还是「这只是 beta」。");
console.log("  2. 再看饰品数和「中位为正/为负」。一个档位只有十几个饰品撑着，跟它超额多高没关系——");
console.log("     那是十几次赌注不是几千次（这正是上一版 +41.6% 的病根）。");
console.log("  3. 最大单品占比高 = 这一档基本是某一个饰品的历史，别当规律读。");
console.log("  4. AUC 那张表只能用来把特征**踢出去**。过了下限什么都不说明（踩坑 46）。");
console.log("  5. 所有档位全部不过成本线，是一个**有效且重要的结论**，不是这次没跑出东西——");
console.log("     它说明现有可观测特征撑不起买入侧，下一步该去找新数据源而不是换模型或换窗口。");
