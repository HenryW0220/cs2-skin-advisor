// 大盘基准的共用模块：算一次、存进 market_baseline_daily（迁移 023）、三个评估脚本共读。
//
// 背景：build-sell-rule-baseline / report-shadow-sell-signals / report-paper-trades 都要
// "当天全市场未来 N 天收益的中位数"这个基准，此前各算各的，而这一段是它们唯一的重活——
// report-paper-trades 在生产库上要 22 分钟，report-shadow-sell-signals 干脆跑不完。
//
// **口径以这里为准**（统一到 build-sell-rule-baseline.mjs 那一套，v2 的阈值就是从它反推的）：
// 按饰品取参考平台 → 按小时重采样 → 每个小时样本算"未来 horizon 天的收益" → 当天所有
// 饰品所有小时样本取中位数。
//
// 用法：
//   import { ensureBaselines, loadBaseline } from "./market-baseline-store.mjs";
//   ensureBaselines(db, [7]);                 // 增量补齐（已存在的天不重算）
//   const base = loadBaseline(db, 7);         // Map(dayMs -> {median, sampleCount, itemCount})
//   console.log(baselineProvenance(db));      // 报告抬头：这份基准是哪一版口径算的
//
// 口径是版本化的（迁移 024）：每行带 calc_version，改口径就是新写一版、旧行永远保留。
// 详见下面 BASELINE_CALIBER 那段。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

// 参考平台优先级跟 lib/signal-summary.ts 一致
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const MIN_SNAPSHOTS_PER_ITEM = 200;
// 一天的基准至少要这么多样本才算数——太少的中位数不可信，宁可这一天没有基准。
// 这条是从 report-shadow-sell-signals / report-paper-trades 那边继承来的，
// build-sell-rule-baseline 原来没有这个下限：差别只出现在数据两端样本极少的那几天。
const MIN_SAMPLES_PER_DAY = 20;

// 收盘之后再等这么久才认为这一天的基准定型：同步偶尔错过整点，留一点余量
const SETTLE_MS = 6 * HOUR_MS;

// ---------- 口径指纹（迁移 024）----------
// market_baseline_daily 是**算出来的中间产物**，不是观测到的事实：三个评估脚本长期复用它，
// 所有引用它的结论都隐含"基准是这套口径算的"。所以这里把口径本身摊开写成一个对象，
// 取它的指纹当 calc_version 存进每一行，并在 market_baseline_meta 里留一份底档。
//
// **改口径 = 新版本，永远不覆盖旧行**。旧行留着，8-13 之前那些引用基准的结论才还能复现——
// 就地重算等于把它们的依据抽走，那是"同一份数据被反复检视"的另一种形式。
// 用指纹而不是手写版本号：手写的迟早有人忘了改，指纹是改了常量就自动变。
//
// ✅ **已修（2026-08-14），修法就是新开一版口径**：定型检查原来是逐小时 `break` 的，
// 而写库是整天写的，于是卡在定型边界上的那天被写成半天且从此不再重算（storedDays 认为
// 它已经有了）。实测旧版 b9645fa10 里窗口 7 天的 2026-08-06 只有 14 小时样本（4550/325），
// 完整重算是 24 小时、中位数从 −2.14% 变成 −2.38%；八个窗口各一天。
// 按迁移 024 的规矩处理：`dayCompleteness` 进指纹 → 新版本 b03672dc0 整体重算，
// **旧行一行不动**，作废原因写进 market_baseline_meta.deprecated_reason（迁移 026）。
// 注意：多数天的样本数不到 24 小时/饰品是**另一回事**（采集本身有缺口，同一小时两端都要有价
// 才算一个样本），那是数据密度不是这个缺陷，别混。
//
// ⚠️ 只有**会影响数字**的东西才能进这个对象。脚本改注释、改性能不该让整表失效，
// 所以 script_sha 只记在 meta 里做取证，不参与指纹。反过来，任何改了数值口径的改动
// （包括中位数在偶数样本上的取法）**必须**在这里显式登记，否则新旧两套会混进同一版。
export const BASELINE_CALIBER = {
  // 一天要**整天**都定型了才写。旧版 b9645fa10 是逐小时判定型、整天写库，于是卡在定型
  // 边界上的那天被写成半天且从此不再重算（每个窗口各一天）。这一条进指纹是有意的：
  // 它改变数字，按迁移 024 的规矩就必须是新的一版。
  dayCompleteness: "whole-day-only",
  // 定型拿**数据末端**当界，不拿墙上时钟（2026-08-23 加，见下面 SETTLE_CLOCK 那段）。
  // 这一条改变数字，所以必须进指纹。
  settleClock: "data-cutoff",
  historyGateHours: "24*(horizon+14)",
  itemUniverse: "DISTINCT item_name FROM price_snapshots",
  medianRule: "even-count=mean-of-two-middles",
  minSamplesPerDay: MIN_SAMPLES_PER_DAY,
  minSnapshotsPerItem: MIN_SNAPSHOTS_PER_ITEM,
  platformPriority: PLATFORM_PRIORITY.join(","),
  resample: "hourly-last",
  settleHours: SETTLE_MS / HOUR_MS,
};

/**
 * 已作废的口径版本，以及**作废的原因和影响量级**。
 *
 * 只标一个 deprecated 是不够的：将来有人翻到旧版本的数字，要能立刻知道它错在哪、错多少，
 * 否则只会卡在"这一天为什么对不上"。所以这里连同复现方式一起写下来，并写进
 * market_baseline_meta.deprecated_reason（迁移 026）。
 */
export const DEPRECATED_CALC_VERSIONS = {
  b9645fa10:
    "边界日半天数据：定型检查逐小时 break、写库却按整天写，导致每个窗口最后一天只用了" +
    "当天前若干小时的样本且从此不再重算。实测窗口 7 天的 2026-08-06 只有 14 小时" +
    "（4550/325，完整应为 24 小时），中位数 -2.14% 而完整重算是 -2.38%。" +
    "八个窗口各有一天受影响（858 行里 8 行）。量级不影响任何已有结论" +
    "（判据是 6.7%~12% 的成本线），但混着两种口径会让将来的复核先卡在对不上账。",
  b03672dc0:
    "同一个缺陷的第二次发生——b9645fa10 的修法没有真正生效。修法是把 " +
    "dayCompleteness=whole-day-only 写进指纹，但那道守卫**只实现在 --daily 分支里**，" +
    "而这一版的整表回填走的是全量模式，于是边界日照样被写成半天。" +
    "叠加第二个原因：定型判据比的是 Date.now() 而不是数据末端，而按踩坑 49 重活是" +
    "**对备份副本跑**的，副本的数据末端落后墙上时钟一截 ⇒ 那一截里的天全被判成已定型。" +
    "两者叠加的结果是**九个窗口各有一天只有 3 小时**（975/325，完整应为 24 小时）：" +
    "窗口 7 的 2026-08-08、8 的 08-07、9 的 08-06、10 的 08-05、11 的 08-04、" +
    "12 的 08-03、13 的 08-02、16 的 07-30、20 的 07-27（2.94 小时，它来自另一次回填）。" +
    "b75ea4af5 把两处都修了：守卫对两个模式一视同仁，定型改用数据末端与墙上时钟取小。",
};
// 键排序后再序列化：指纹不能因为字段书写顺序变了就变
export const BASELINE_CALIBER_JSON = JSON.stringify(
  Object.fromEntries(Object.entries(BASELINE_CALIBER).sort(([a], [b]) => a.localeCompare(b)))
);
export const BASELINE_CALC_VERSION =
  "b" + createHash("sha1").update(BASELINE_CALIBER_JSON).digest("hex").slice(0, 8);

// 生成这批行的**脚本内容**指纹。比 git commit 准：手工拷进容器跑出来的那种（正是
// 8-13 首次回填的情况）在 git 上找不到对应 commit，但内容指纹认得出来。
function scriptSha() {
  try {
    return createHash("sha1")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex")
      .slice(0, 12);
  } catch {
    return "unknown";
  }
}

// 真正的同步 sleep。**不能用忙等**——这台机器只有一个核，忙等是把"占着磁盘"换成
// "占着 CPU"，采集器一样跑不动。better-sqlite3 是全同步 API，改 async 会波及三个调用方，
// 所以用 Atomics.wait 在一个没人会唤醒的 SharedArrayBuffer 上等，真正让出 CPU。
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function referencePlatform(db, itemName) {
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

/**
 * 按小时重采样的价格序列。`fromMs` 给定时只读这个时间点之后的部分——
 * **日常增量靠这个才便宜**：只补刚刚成熟的那一天时，每个饰品只需要 [D, D+窗口] 这一小段，
 * 而不是把 111 天历史整个读出来。不给 `fromMs` 就是全量（首次回填走这条）。
 */
function hourlyPrices(db, itemName, platform, fromMs = null) {
  const rows =
    fromMs === null
      ? db
          .prepare(
            `SELECT captured_at, price FROM price_snapshots
             WHERE item_name = ? AND platform = ? AND price > 0 ORDER BY captured_at ASC`
          )
          .all(itemName, platform)
      : db
          .prepare(
            `SELECT captured_at, price FROM price_snapshots
             WHERE item_name = ? AND platform = ? AND price > 0 AND captured_at >= ?
             ORDER BY captured_at ASC`
          )
          .all(itemName, platform, new Date(fromMs).toISOString());
  const byHour = new Map();
  for (const r of rows) {
    byHour.set(Math.floor(Date.parse(r.captured_at) / HOUR_MS) * HOUR_MS, r.price);
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * 这个饰品一共有多少个不同的小时桶（历史长度门槛用的就是这个数）。
 *
 * **为什么不能省掉这一步直接用截断后的序列长度**：门槛 `24×(窗口+14)` 判的是
 * **全部历史**够不够长，而日常增量只读最近几天——拿截断后的长度去判，几乎所有饰品都会
 * 被判为"历史不够"而被剔掉，**参与基准的饰品集合就变了，基准跟着变，v2 那些阈值的
 * 依据也就漂了**。更糟的是 `BASELINE_CALC_VERSION` 只按常量算，这种改动**不会**让口径
 * 指纹变化，于是新旧两套数字会混进同一版里而没有任何东西报错——正是迁移 024 要防的事。
 * 所以门槛照旧用全量口径，只是改成一条聚合查询拿回一个数，不再把整段历史读进 JS。
 */
function hourBucketCount(db, itemName, platform) {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT substr(captured_at, 1, 13)) n FROM price_snapshots
       WHERE item_name = ? AND platform = ? AND price > 0`
    )
    .get(itemName, platform).n;
}

const dayKey = (ms) => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);

/**
 * 定型的界：**数据末端**和墙上时钟取小的那个。
 *
 * "这一天的基准定型了"意思是**算它所需要的数据都已经观测到了**——那是数据的属性，
 * 不是时钟的属性。原来这里是 `Date.now()`，只在"库就是生产库、一直写到此刻"时才等价。
 * 而踩坑 49 规定重活必须**对备份副本跑**，副本的数据末端天生落后墙上时钟一截，
 * 于是那一截里的每一天都被判成"已定型"，实际却只有开头几个小时能算出 T+N。
 *
 * **后果不可逆**：写出去的行按护栏 (b) 永不重算（`storedDays` 认为这天已经有了）。
 * 实测 b03672dc0 的九个窗口**各有一天是 3 小时**（正常是 24 小时/饰品）——
 * 那是 8-16 那次对 8-15/8-16 的备份跑全量回填留下的，每个窗口的最后一天全中。
 *
 * 仍然跟 `Date.now()` 取小：万一库里有未来时间戳（时钟漂移、脏数据），不能让它把
 * 还没真正走完的日子拉进来。
 */
export function settleCutoff(db) {
  const row = db.prepare("SELECT MAX(captured_at) m FROM price_snapshots").get();
  const dataEnd = row?.m ? Date.parse(row.m) : NaN;
  return Number.isFinite(dataEnd) ? Math.min(dataEnd, Date.now()) : Date.now();
}

function storedDays(db, horizon) {
  return new Set(
    db
      .prepare("SELECT day FROM market_baseline_daily WHERE horizon_days = ? AND calc_version = ?")
      .all(horizon, BASELINE_CALC_VERSION)
      .map((r) => r.day)
  );
}

/** 把这一版口径的底档写进 market_baseline_meta（幂等，每次跑完刷新区间和行数）。 */
function upsertMeta(db) {
  const stat = db
    .prepare(
      `SELECT COUNT(*) rows, MIN(day) first_day, MAX(day) last_day,
              GROUP_CONCAT(DISTINCT horizon_days) horizons
       FROM market_baseline_daily WHERE calc_version = ?`
    )
    .get(BASELINE_CALC_VERSION);
  db.prepare(
    `INSERT INTO market_baseline_meta
       (calc_version, caliber_json, script_sha, git_commit, horizons, first_day, last_day, row_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(calc_version) DO UPDATE SET
       script_sha = excluded.script_sha,
       git_commit = excluded.git_commit,
       horizons = excluded.horizons,
       first_day = excluded.first_day,
       last_day = excluded.last_day,
       row_count = excluded.row_count,
       updated_at = datetime('now')`
  ).run(
    BASELINE_CALC_VERSION,
    BASELINE_CALIBER_JSON,
    scriptSha(),
    process.env.GIT_COMMIT ?? "unknown",
    stat.horizons ?? "",
    stat.first_day,
    stat.last_day,
    stat.rows
  );

  // 把已知作废版本的原因写进 meta（迁移 026）。**只标 deprecated 是不够的**：
  // 将来有人翻到旧版本的数字，要能立刻知道它错在哪、错多少，否则只会卡在"这天为什么对不上"。
  const markDeprecated = db.prepare(
    `UPDATE market_baseline_meta SET deprecated_reason = ?, deprecated_at = COALESCE(deprecated_at, datetime('now'))
     WHERE calc_version = ? AND (deprecated_reason IS NULL OR deprecated_reason <> ?)`
  );
  for (const [version, reason] of Object.entries(DEPRECATED_CALC_VERSIONS)) {
    if (version === BASELINE_CALC_VERSION) continue; // 当前版本不能标自己作废
    markDeprecated.run(reason, version, reason);
  }
}

/**
 * 增量补齐给定窗口的基准。已经存过的 (天, 窗口) 不重算——价格只追加，
 * 一天的基准在 day + horizon + 6 小时之后就不会再变。
 *
 * @param horizons 要算的窗口天数数组，比如 [7] 或 [7, 12, 14]
 * @returns 每个窗口新写入了多少天
 */
export function ensureBaselines(db, horizons, { verbose = false, throttleMs = 0, daily = false } = {}) {
  const pending = horizons.filter((h) => Number.isFinite(h) && h > 0);
  if (!pending.length) return {};

  const existing = new Map(pending.map((h) => [h, storedDays(db, h)]));
  const cutoff = settleCutoff(db);

  // ---- daily 模式：只补"刚刚成熟的那几天"，不做全表扫 ----
  // 一天的基准要到 day + horizon + 6h 才定型，所以**报告永远缺最近 horizon 天**，
  // 这是成熟度的形状不是缺口。真正需要每天补的只有边界上那一两天。
  // 算出所有 pending 窗口里"还没存过且已经定型"的最早那一天，从它往前一点开始读就够了——
  // 每个饰品只读几天而不是整段历史。门槛仍然按全量口径判（见 hourBucketCount 的注释）。
  let readFromMs = null;
  if (daily) {
    let earliest = Infinity;
    for (const horizon of pending) {
      const done = existing.get(horizon);
      // 从最新往回找，找到第一个"已定型但没存过"的日子；最多回溯 30 天，
      // 再往前说明这不是日常增量而是补历史，那种情况不该走 daily 模式
      for (let back = 0; back <= 30; back++) {
        const dayMs = Math.floor((cutoff - back * DAY_MS) / DAY_MS) * DAY_MS;
        // ⚠️ 判定用**当天最后一个小时**而不是 00:00。用 00:00 的话，一天刚够到定型线时
        // 这一天就会被选中，但它靠后的那些小时还没到期，下面的循环会 break 掉，
        // 于是**写进去的是半天数据、而且从此不再重算**（storedDays 认为这天已经有了）。
        // 生产库里已经存在这样的行：窗口 7 天的 2026-08-06 只有 14 小时（4550/325），
        // 而完整的一天是 24 小时——那是 8-13 19:25 那次回填卡在定型边界上冻住的。
        // 晚一天写、写完整的，比早一天写、永久半份要好。
        const lastHourMs = dayMs + DAY_MS - HOUR_MS;
        if (lastHourMs + horizon * DAY_MS + SETTLE_MS > cutoff) continue; // 整天还没定型
        if (done.has(dayKey(dayMs))) continue; // 已经有了
        earliest = Math.min(earliest, dayMs);
      }
    }
    if (earliest === Infinity) {
      if (verbose) console.log("[market-baseline] daily：没有已定型且缺失的日子，无事可做");
      return {};
    }
    // 往前留一天余量，避免边界上的小时桶被切掉
    readFromMs = earliest - DAY_MS;
    if (verbose) {
      console.log(
        `[market-baseline] daily 模式：只补 ${dayKey(earliest)} 起的日子，` +
          `每个饰品从 ${new Date(readFromMs).toISOString().slice(0, 10)} 读起（不是全量）`
      );
    }
  }

  // 样本落到一张临时表里再让 SQLite 排序求中位数，**不在内存里攒**。
  // 这台机器是 1 核 1GB：第一版把所有 (天, 窗口) 的收益数组全揣在 JS 里，跑了 25 分钟
  // 还没写出一行，`top` 里 kswapd0 一直在 D 状态——是在swap上打转，不是在算。
  // 排序交给 SQLite 之后内存占用跟样本数无关（踩坑 28 是同一台机器上的同一类问题）。
  db.exec(`
    DROP TABLE IF EXISTS _baseline_samples;
    CREATE TEMP TABLE _baseline_samples (horizon INTEGER, day TEXT, item TEXT, ret REAL);
  `);
  const insertSample = db.prepare(
    "INSERT INTO _baseline_samples (horizon, day, item, ret) VALUES (?, ?, ?, ?)"
  );
  // **必须按饰品打包成一个事务**：better-sqlite3 的裸 INSERT 每条都是一个隐式事务，
  // 一个饰品两千多条样本 × 七百个饰品 = 一百多万次事务提交，实测慢到跑不完。
  // 一个饰品一次提交（几千条）在这台 1 核机器上是几十毫秒的事。
  const insertItemSamples = db.transaction((rows) => {
    for (const r of rows) insertSample.run(r[0], r[1], r[2], r[3]);
  });

  const items = db
    .prepare("SELECT DISTINCT item_name FROM price_snapshots")
    .all()
    .map((r) => r.item_name);

  let processed = 0;
  for (const item of items) {
    const platform = referencePlatform(db, item);
    if (!platform) continue;
    const series = hourlyPrices(db, item, platform, readFromMs);
    // 门槛判的是全部历史的长度。全量模式下 series 本身就是全部历史，直接用它的长度；
    // daily 模式下 series 是截断过的，必须另外问一次全量的小时桶数，否则会改变
    // 参与基准的饰品集合（见 hourBucketCount 的注释）
    const fullLength = readFromMs === null ? series.length : hourBucketCount(db, item, platform);
    const hourIndex = new Map(series.map(([h], i) => [h, i]));
    const samples = [];
    for (const horizon of pending) {
      // 历史长度门槛跟 build-sell-rule-baseline.mjs 完全一致（24 × (窗口 + 14) 小时）。
      // **这条必须对齐**：v2 的全部阈值是从那个脚本反推的，参与基准的饰品集合一变，
      // 基准就变、超额就变，那些阈值的依据也就跟着漂了。
      if (fullLength < 24 * (horizon + 14)) continue;
      const done = existing.get(horizon);
      for (let i = 0; i < series.length; i++) {
        const [ts, price] = series[i];
        // 这一天的基准要定型才算，否则今天算一半、明天又变
        if (ts + horizon * DAY_MS + SETTLE_MS > cutoff) break;
        const day = dayKey(ts);
        if (done.has(day)) continue;
        // **整天**都定型了才写。逐小时 break 会让卡在定型边界上的那天只写进去半天、
        // 而且从此不再重算（见文件上方"已知缺陷"）。晚一天写、写完整的，比早一天写、
        // 永久半份要好。
        //
        // ⚠️ 这一条原来**只在 daily 模式里执行**，注释写的是"全量模式保持原样不动，
        // 两个模式的差别只有这一天现在写还是明天写，写下去的值完全同口径"。
        // **那句话不成立**：全量模式会把边界日写下去（只带成熟的那几个小时），
        // daily 模式会跳过它、下次写整天——同一天的两个值不同口径。
        // 而 `dayCompleteness: "whole-day-only"` 是写进**指纹**的，指纹不分模式。
        // 于是 b03672dc0 整表回填（走全量）复发了它本该修掉的那个缺陷。
        // **一个口径只在一半的代码路径上执行，而指纹让人以为它全局成立。**
        const dayEndMs = Math.floor(ts / DAY_MS) * DAY_MS + DAY_MS - HOUR_MS;
        if (dayEndMs + horizon * DAY_MS + SETTLE_MS > cutoff) break;

        const futureIdx = hourIndex.get(ts + horizon * DAY_MS);
        if (futureIdx === undefined) continue;
        const fwd = (series[futureIdx][1] - price) / price;
        if (!Number.isFinite(fwd)) continue;

        samples.push([horizon, day, item, fwd]);
      }
    }
    if (samples.length) insertItemSamples(samples);

    processed += 1;
    if (verbose && processed % 100 === 0) {
      console.log(`[market-baseline] 已扫 ${processed}/${items.length} 个饰品`);
    }
    // 每个饰品之间歇一下，把磁盘让给常驻采集器。**对副本跑只解决了写锁冲突，没解决
    // 磁盘争用**：2026-08-14 实测对副本跑的时候，采集器那边 10 分钟的快速同步照样
    // 交不出一条写入。这台机器只有一块盘、一个核，重活必须自己让路（踩坑 49）。
    if (throttleMs > 0) sleepSync(throttleMs);
  }

  // 写进当前口径版本那一格。**别的版本的行一行都不碰**——改口径是新写一版，
  // 不是就地重算（迁移 024 的整个理由）。同版本内重复写是幂等的（增量已经跳过存过的天，
  // 这条 upsert 只在同一天被重复要求时兜底）。
  const insert = db.prepare(
    `INSERT INTO market_baseline_daily
       (day, horizon_days, calc_version, median_return, sample_count, item_count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, horizon_days, calc_version) DO UPDATE SET
       median_return = excluded.median_return,
       sample_count = excluded.sample_count,
       item_count = excluded.item_count,
       computed_at = datetime('now')`
  );

  // 中位数交给 SQLite 算：按 (窗口, 天) 分组排序，取中间那一条（偶数条时取中间两条的均值，
  // 跟 JS 版 `s[Math.floor(len/2)]` 的差别只在偶数样本上，对 20 条起步的分组可以忽略）。
  const aggregated = db
    .prepare(
      `WITH ranked AS (
         SELECT horizon, day, ret,
                ROW_NUMBER() OVER (PARTITION BY horizon, day ORDER BY ret) rn,
                COUNT(*) OVER (PARTITION BY horizon, day) cnt
         FROM _baseline_samples
       ),
       med AS (
         SELECT horizon, day, AVG(ret) median_return, MAX(cnt) sample_count
         FROM ranked WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
         GROUP BY horizon, day
       )
       SELECT m.horizon, m.day, m.median_return, m.sample_count,
              (SELECT COUNT(DISTINCT s.item) FROM _baseline_samples s
                WHERE s.horizon = m.horizon AND s.day = m.day) item_count
       FROM med m WHERE m.sample_count >= ?`
    )
    .all(MIN_SAMPLES_PER_DAY);

  // ---- 写入前的最后一道：这一天的每个小时都必须真的被数据覆盖住 ----
  // 上面的定型守卫（`dayEndMs + horizon + SETTLE > cutoff` → break）已经从**时间**上保证了
  // 这件事，这里是从**结果**上再验一次。两道判据独立：一道看钟，一道数数。
  //
  // **为什么值得再来一道**：这张表的行按护栏 (b) 永不重算，**写错一行就永久错着**。
  // 而这个缺陷已经发生过两次，两次都是"守卫看起来对、但没覆盖到那条路径"——
  // b9645fa10 是逐小时 break、b03672dc0 是 whole-day-only 只写在 --daily 分支里。
  // **靠一道守卫的正确性来保护一个不可逆的写入，已经被证明不够。**
  const availableHours = db.prepare(
    `SELECT COUNT(DISTINCT substr(captured_at, 1, 13)) n FROM price_snapshots
     WHERE substr(captured_at, 1, 10) = ? AND price > 0`
  );
  // ⚠️ **判据是"塌陷"不是"有缺口"，这个区别决定这道断言能不能活下来。**
  // `used` 会因为**散落的采集缺口**天然低于 `avail`：某个饰品在 D+N 那一小时没价，
  // 这一对就没了。实测生产库里 2026-07-26 是 22.84/24（C5 提频当天的真实缺口），
  // 那是**正常的**。按 `used < avail − 1` 去卡会打到一大片正确的行，
  // 而一条经常误报的断言两周内就会被加上 `|| true`——那时它比没有更糟。
  //
  // 截断的形状是**塌陷**：3/24 = 12.5%。散落缺口是 22.84/24 = 95%。中间差着一个数量级。
  // 取 50% 当界，两边都留了很大余地。
  // b9645fa10 那次的 14/24 = 58% 落在这条之上，由 `assertNoTruncatedTail`（跟邻日比）接住——
  // **两道网、不同阈值、不同参照系**：这一道跟当天源数据比，那一道跟前几天比。
  const COLLAPSE_RATIO = 0.5;
  const truncated = [];
  for (const r of aggregated) {
    const used = r.sample_count / r.item_count;
    const avail = availableHours.get(r.day).n;
    if (avail > 0 && used < avail * COLLAPSE_RATIO) {
      truncated.push(
        `  · 窗口 ${r.horizon} 天 / ${r.day}：只用了 ${used.toFixed(2)} 小时，` +
          `而当天源数据有 ${avail} 小时（${((used / avail) * 100).toFixed(0)}%）`
      );
    }
  }
  if (truncated.length) {
    throw new Error(
      `✗ 拒绝写入 ${truncated.length} 行被截断的基准：\n` +
        truncated.join("\n") +
        `\n\n这一天的部分小时取不到 T+N 的对手价，写下去就是永久的半份（护栏 (b) 不重算）。` +
        `\n定型判据（settleClock=data-cutoff）本应挡住它——走到这里说明那道守卫漏了，` +
        `\n**先查守卫，不要放宽这条**。数据末端：${new Date(cutoff).toISOString()}`
    );
  }

  const written = {};
  const writeAll = db.transaction((rows) => {
    for (const r of rows) {
      insert.run(r.day, r.horizon, BASELINE_CALC_VERSION, r.median_return, r.sample_count, r.item_count);
      written[r.horizon] = (written[r.horizon] ?? 0) + 1;
    }
    upsertMeta(db);
  });
  writeAll(aggregated);
  db.exec("DROP TABLE IF EXISTS _baseline_samples");

  if (verbose) {
    console.log(`[market-baseline] 口径版本 ${BASELINE_CALC_VERSION}：${BASELINE_CALIBER_JSON}`);
    for (const horizon of pending) {
      console.log(`[market-baseline] 窗口 ${horizon} 天：新写入 ${written[horizon] ?? 0} 天`);
    }
  }
  return written;
}

/**
 * 每日采集规模写进 market_regime_daily（迁移 025）。**这是数据本身的属性，跟基准口径无关**，
 * 所以不挂在 market_baseline_daily 上、也不带 calc_version（挂上去会让同一个事实在每个口径
 * 版本里各存一份，而且按护栏 (b) 存量行不能改写，加列只会得到一堆 NULL）。
 * `fromDay` 给定时只算那天之后（日常增量用），不给就是全量（首次/补历史用）。
 */
export function recordRegimeDaily(db, fromDay = null) {
  const rows = db
    .prepare(
      `SELECT substr(captured_at, 1, 10) day, COUNT(*) rows_n,
              COUNT(DISTINCT item_name) items, COUNT(DISTINCT platform) platforms
       FROM price_snapshots
       WHERE (? IS NULL OR captured_at >= ?)
       GROUP BY 1`
    )
    .all(fromDay, fromDay ? `${fromDay}T00:00:00.000Z` : null);
  const insert = db.prepare(
    `INSERT INTO market_regime_daily (day, snapshot_rows, item_count, platform_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       snapshot_rows = excluded.snapshot_rows,
       item_count = excluded.item_count,
       platform_count = excluded.platform_count,
       computed_at = datetime('now')`
  );
  // 这张表存的是"当天实际发生了什么"，同一天重算得到同样的结果（除非当天还没过完），
  // 所以 upsert 是安全的——**它跟基准那张"不得改写存量行"的表性质不同**：
  // 基准是用某套口径算出来的解释，régime 是数据本身的属性。
  db.transaction(() => {
    for (const r of rows) insert.run(r.day, r.rows_n, r.items, r.platforms);
  })();
  return rows.length;
}

/**
 * 读出某个窗口的全部基准。key 是当天 00:00 UTC 的毫秒时间戳，跟脚本里 day 的算法对齐。
 * 默认只读**当前口径版本**的行——表里可以并存多版，混着读等于混口径。
 *
 * **默认跳过被标作废的行**（迁移 028 的 `invalid_reason`）。
 * 这一条是让"作废"真的生效的地方：光在表里写一句原因、读取端照读不误，
 * 那个标记就只是注释。**跳过之后调用方会走到"缺基准"那条已有的分支**，
 * 而那条分支是有留痕的（`missingBaselineByDay` / `missingSettled`），不会静默。
 *
 * `includeInvalid: true` 用于**取证**——复现 8-16 那批引用 b03672dc0 的结论时要读到原值。
 * 护栏 (b) 说旧行不得改写，迁移 028 也确实一个数都没改，所以原值一直在。
 */
export function loadBaseline(
  db,
  horizon,
  calcVersion = BASELINE_CALC_VERSION,
  { includeInvalid = false } = {}
) {
  const rows = db
    .prepare(
      `SELECT day, median_return, sample_count, item_count, invalid_reason
       FROM market_baseline_daily
       WHERE horizon_days = ? AND calc_version = ?`
    )
    .all(horizon, calcVersion);
  const usable = includeInvalid ? rows : rows.filter((r) => r.invalid_reason === null);
  // **跳过了多少行必须说出来。** 静默跳过跟静默丢样本是同一个毛病：
  // 数字看起来完全正常，只是少了几天。
  const skipped = rows.length - usable.length;
  if (skipped > 0) {
    console.log(
      `[market-baseline] ⚠️ 窗口 ${horizon} 天：跳过 ${skipped} 行已作废的基准` +
        `（${calcVersion}，迁移 028）。这些天会走"缺基准"分支，下面的剔除计数里看得到。`
    );
  }
  return new Map(
    usable.map((r) => [
      Date.parse(`${r.day}T00:00:00.000Z`),
      { median: r.median_return, sampleCount: r.sample_count, itemCount: r.item_count },
    ])
  );
}

/**
 * 站岗断言：表里不许有**被截断**的行。
 *
 * ---- 为什么判据不是"小时数 < 24 就失败" ----
 * 那条会打到大约七百行**正确**的历史数据：2026-05 每天只有约 17.3 小时、06 月约 22.6 小时，
 * 那是**当时采集频率就那样**，所有拿得到的小时都用上了——**完整，只是稀疏**。
 * 而这次的坏行是"当天有 24 小时的数据，却只用了 3 小时"。
 * **两件事必须分开**，`market-baseline-store.mjs` 顶上那段注释专门写了"别混"。
 * 一条大部分时候在误报的断言活不过两周——它会被人加上 `|| true` 然后永远绿着。
 *
 * ---- 真正的判据：尾部塌陷 ----
 * 截断这个缺陷有确定性的形状：**它只发生在每个 (版本, 窗口) 的最后一天**
 * （定型判据放行了它，然后数据不够）。而采集密度是**渐变**的，不会在最后一天掉一个量级。
 * 所以判据是：**最后一行的小时数不得低于它前面若干天中位数的 60%。**
 * 实测这条能同时抓住两次：b03672dc0 的 3h vs 24h（12.5%）、b9645fa10 的 14h vs 24h（58%）。
 *
 * 显式标了 `invalid_reason` 的行跳过——那是"已经知道并登记了"，不是"没发现"。
 */
export function assertNoTruncatedTail(db, { throwOnFail = true } = {}) {
  const TAIL_MIN_RATIO = 0.6;
  const LOOKBACK = 7;
  const problems = [];
  // **整版已作废的版本整体跳过。** 迁移 026 的 `deprecated_reason` 就是"已经知道、已经登记、
  // 已经写清错在哪和错多少"的意思——再报一次不是发现，是噪音。
  // 实测这一条是必要的：b9645fa10 的窗口 7 / 2026-08-06 正是 14 小时，
  // 而它**已经**逐字写在 `DEPRECATED_CALC_VERSIONS.b9645fa10` 里了。
  // 不跳的话这条断言从上线第一天起就永远红着，然后被人关掉——
  // 那正是这整套防线最怕的结局。
  const deprecated = new Set(
    db
      .prepare("SELECT calc_version FROM market_baseline_meta WHERE deprecated_reason IS NOT NULL")
      .all()
      .map((r) => r.calc_version)
  );
  const groups = db
    .prepare(
      `SELECT DISTINCT calc_version, horizon_days FROM market_baseline_daily
       ORDER BY calc_version, horizon_days`
    )
    .all()
    .filter((g) => !deprecated.has(g.calc_version));
  for (const g of groups) {
    const rows = db
      .prepare(
        `SELECT day, sample_count, item_count, invalid_reason
         FROM market_baseline_daily
         WHERE calc_version = ? AND horizon_days = ? AND item_count > 0
         ORDER BY day`
      )
      .all(g.calc_version, g.horizon_days);
    if (rows.length < 3) continue;
    const last = rows[rows.length - 1];
    if (last.invalid_reason !== null) continue; // 已登记，不算未发现
    const hoursOf = (r) => r.sample_count / r.item_count;
    const prev = rows.slice(Math.max(0, rows.length - 1 - LOOKBACK), rows.length - 1).map(hoursOf);
    if (!prev.length) continue;
    const sorted = [...prev].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const ref = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    if (ref > 0 && hoursOf(last) < ref * TAIL_MIN_RATIO) {
      problems.push(
        `  · ${g.calc_version} / 窗口 ${g.horizon_days} 天：最后一天 ${last.day} 只有 ` +
          `${hoursOf(last).toFixed(2)} 小时，而前 ${prev.length} 天中位是 ${ref.toFixed(2)} 小时` +
          `（${((hoursOf(last) / ref) * 100).toFixed(0)}%）`
      );
    }
  }
  if (problems.length && throwOnFail) {
    throw new Error(
      `✗ market_baseline_daily 有被截断的尾行（${problems.length} 处）：\n` +
        problems.join("\n") +
        `\n\n这是"定型判据放行了这一天、但数据其实还没到"的形状（HANDOFF ㉜）。` +
        `\n这些行按护栏 (b) 永不重算，所以必须当场拦住。` +
        `\n若确认是已知的历史坏行，用迁移 028 的 invalid_reason 显式登记它。`
    );
  }
  return problems;
}

/**
 * 断言基准**覆盖了本次真正要用到的那些天**，不只是"这一版有行"。
 *
 * ---- 为什么必须有这个（2026-08-15，护栏 (d)）----
 * `assertBaselineTable` 只检查"当前口径版本在表里有没有行"。**有一行它就放行。**
 * 于是存在这样一条后门：用 `--daily` 给一个全新的口径版本补基准时，它最多只回溯 30 天
 * （见 ensureBaselines 里的 `back <= 30`），一版需要 113 天的基准会被补成**只有最近 24 天**，
 * 而 `assertBaselineTable` **照样放行**。接下来评估脚本里那句
 * `const base = marketByDay.get(day); if (base === undefined) continue;`
 * 会把落在其余 89 天的样本**静默丢掉、连计数都没有**，然后给出一套"重新反推的阈值"——
 * 数字看起来完全正常，只是基于 20% 的数据。
 *
 * **这正是迁移 024 那套护栏要防的形状，而它发生在护栏内部。**丢样本不计数是最难发现的
 * 一类失效：不报错、不告警、结果自洽。
 *
 * ---- 三种缺失要分开处理，这是这个函数的全部意义 ----
 *   · **早于 first_day** → 硬失败。基准根本没算到那么早（--daily 补新版本就长这样）。
 *   · **落在 [first_day, last_day] 中间却没有行** → 硬失败。那是个洞，不该存在。
 *   · **晚于 last_day** → **不失败**，这是成熟度前沿：一天的基准要到 day+horizon+6h 才定型，
 *     所以**报告永远缺最新 horizon 天**，这是形状不是缺口（护栏 (c) 早就记过）。
 *     但要**返回计数让调用方打印出来**，把静默丢弃变成留痕。
 *
 * @param requiredDays 本次真正要用到的天（毫秒时间戳，当天 00:00 UTC），可迭代
 * @returns { coveredDays, frontierDays: string[], frontierCount } —— 调用方应当把前沿打印出来
 */
export function assertBaselineCoverage(
  db,
  horizon,
  requiredDays,
  { label = "", calcVersion = BASELINE_CALC_VERSION } = {}
) {
  const span = db
    .prepare(
      `SELECT MIN(day) first_day, MAX(day) last_day, COUNT(*) rows
       FROM market_baseline_daily WHERE horizon_days = ? AND calc_version = ?`
    )
    .get(horizon, calcVersion);
  if (!span.rows) {
    throw new Error(
      `基准里没有窗口 ${horizon} 天 / 口径 ${calcVersion} 的任何一行。先跑 build-market-baseline.mjs。`
    );
  }
  const have = new Set(
    db
      .prepare("SELECT day FROM market_baseline_daily WHERE horizon_days = ? AND calc_version = ?")
      .all(horizon, calcVersion)
      .map((r) => r.day)
  );

  const tooEarly = [];
  const holes = [];
  const frontier = [];
  let covered = 0;
  for (const ms of new Set(requiredDays)) {
    const key = dayKey(ms);
    if (have.has(key)) {
      covered += 1;
      continue;
    }
    if (key < span.first_day) tooEarly.push(key);
    else if (key > span.last_day) frontier.push(key);
    else holes.push(key);
  }

  if (tooEarly.length || holes.length) {
    const show = (a) => (a.length > 6 ? `${a.slice(0, 6).join("、")} 等 ${a.length} 天` : a.join("、"));
    throw new Error(
      `基准覆盖不全${label ? `（${label}）` : ""}：窗口 ${horizon} 天 / 口径 ${calcVersion} 只覆盖 ` +
        `${span.first_day} ~ ${span.last_day}（${span.rows} 行），但本次要用到的天里——\n` +
        (tooEarly.length ? `  · ${tooEarly.length} 天**早于基准起点**：${show(tooEarly.sort())}\n` : "") +
        (holes.length ? `  · ${holes.length} 天**落在基准区间内却没有行**（洞）：${show(holes.sort())}\n` : "") +
        `**这不是"最新几天还没定型"**（那种情况在 last_day 之后，本函数不会报错）。\n` +
        `最可能的原因：这一版口径是用 --daily 补的，而 --daily 最多只回溯 30 天。\n` +
        `修法是用**全量模式**把这一版补齐：node scripts/build-market-baseline.mjs ${horizon} …\n` +
        `**不要把这个断言关掉**——关掉之后这些天的样本会被静默丢弃，报告照样出数字。`
    );
  }
  assertCoverageFrontier(db, horizon, { calcVersion, label });

  return { coveredDays: covered, frontierDays: frontier.sort(), frontierCount: frontier.length };
}

/**
 * 断言这一版的覆盖**没有提前截止**——即 last_day 追得上数据本来允许算到的那一天。
 *
 * ---- 为什么单独要这一条 ----
 * `assertBaselineCoverage` 把"晚于 last_day"一律当成**成熟度前沿**放行，理由是
 * "报告永远缺最新 horizon 天，那是形状不是缺口"。**那个理由只在 last_day 本身是对的时候成立。**
 *
 * 2026-08-23 实测到反例：b03672dc0 的窗口 7 天止于 **2026-08-08**，而数据一直到 08-22——
 * 按定型规则本该算到 **08-13**。中间那 5 天全部落进"前沿"被放行，
 * 于是 `report-shadow-sell-signals` 里 **1483 条样本**被当成"还没到期"剔掉，报告照常出数字。
 * **根因是坏行同时堵住了后面的天**：`storedDays` 认为 08-08 已经有了，
 * 增量便从 08-09 起算，而 08-09 之后没人跑过 builder。
 *
 * **一句话：前沿的宽容必须有上界，否则"缺了五天"和"最新一天还没熟"长得一模一样。**
 *
 * 容差取 2 天：builder 是手动跑的，落后一天属正常作息；落后两天以上就是停了。
 */
export function assertCoverageFrontier(
  db,
  horizon,
  { calcVersion = BASELINE_CALC_VERSION, label = "", toleranceDays = 2, throwOnFail = true } = {}
) {
  const span = db
    .prepare(
      `SELECT MAX(day) last_day FROM market_baseline_daily
       WHERE horizon_days = ? AND calc_version = ? AND invalid_reason IS NULL`
    )
    .get(horizon, calcVersion);
  if (!span?.last_day) return null;

  const cutoff = settleCutoff(db);
  // 数据允许算到的最后一天：它最后一个小时的 T+N 再加定型余量必须落在数据末端之内
  let expected = null;
  for (let back = 0; back <= 60; back++) {
    const dayMs = Math.floor(cutoff / DAY_MS) * DAY_MS - back * DAY_MS;
    if (dayMs + DAY_MS - HOUR_MS + horizon * DAY_MS + SETTLE_MS <= cutoff) {
      expected = dayMs;
      break;
    }
  }
  if (expected === null) return null;

  const expectedKey = dayKey(expected);
  const lagDays = Math.round((expected - Date.parse(`${span.last_day}T00:00:00.000Z`)) / DAY_MS);
  if (lagDays > toleranceDays) {
    const msg =
      `✗ 基准覆盖提前截止${label ? `（${label}）` : ""}：窗口 ${horizon} 天 / 口径 ${calcVersion} ` +
      `止于 ${span.last_day}，而数据（末端 ${new Date(cutoff).toISOString()}）本该允许算到 ` +
      `${expectedKey}——**落后 ${lagDays} 天**。\n` +
      `这 ${lagDays} 天的样本会被当成"还没到期"静默剔除，而报告照常出数字（HANDOFF ㉜ 实测 1483 条）。\n` +
      `修法：node scripts/build-market-baseline.mjs ${horizon} --daily\n` +
      `若 --daily 说"无事可做"，多半是边界日被写成了坏行、把后面的天一起堵住了——` +
      `查 assertNoTruncatedTail。`;
    if (throwOnFail) throw new Error(msg);
    return msg;
  }
  return null;
}

/** 报告脚本抬头打这一行：任何引用基准的数字，都要能说清是哪一版口径算的。 */
export function baselineProvenance(db, calcVersion = BASELINE_CALC_VERSION) {
  const meta = db.prepare("SELECT * FROM market_baseline_meta WHERE calc_version = ?").get(calcVersion);
  if (!meta) return `基准口径版本 ${calcVersion}：meta 里没有这一版的底档`;
  return (
    `基准口径版本 ${calcVersion}（脚本 ${meta.script_sha} / commit ${meta.git_commit}）：` +
    `${meta.row_count} 行、窗口 ${meta.horizons} 天、${meta.first_day} ~ ${meta.last_day}\n` +
    `  口径：${meta.caliber_json}`
  );
}

/**
 * 表还没建（迁移没跑）时给一句人话，而不是抛一个 no such table。
 * 顺带挡住"口径改了但表里没有这一版"的情况——不挡的话 loadBaseline 会返回空 Map，
 * 报告脚本只会说"还没有基准，去跑 builder"，把**口径失配**说成**数据没到**。
 */
export function assertBaselineTable(db, { requireCurrentVersion = true } = {}) {
  for (const name of ["market_baseline_daily", "market_baseline_meta"]) {
    const row = db
      .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name);
    if (!row.c) {
      throw new Error(
        `${name} 不存在——迁移 023/024 还没跑。容器重启一次（进程启动时会自动跑迁移）再来。`
      );
    }
  }
  // 迁移 028 的三列：`loadBaseline` 和 `assertNoTruncatedTail` 都要读 `invalid_reason`。
  // **少了这一列会抛 `SqliteError: no such column: invalid_reason`**——那是给库看的，不是给人看的，
  // 跟这个函数开头拦 `no such table` 是同一个理由（实测过一次：对一份没跑 028 的副本跑报告，
  // 得到的就是一串 better-sqlite3 的堆栈）。
  const cols = new Set(
    db.prepare("SELECT name FROM pragma_table_info('market_baseline_daily')").all().map((r) => r.name)
  );
  for (const col of ["invalid_reason", "invalidated_at", "superseded_by"]) {
    if (!cols.has(col)) {
      throw new Error(
        `market_baseline_daily 缺列 ${col}——迁移 028 还没跑。\n` +
          `容器重启一次（进程启动时会自动跑迁移）；对本机副本跑分析脚本的话，\n` +
          `副本要来自已经跑过 028 的库，或者手动把 db/migrations/028_*.sql 应用上去。`
      );
    }
  }

  const rows = db.prepare("SELECT COUNT(*) c FROM market_baseline_daily").get().c;
  if (!rows) return; // 空表是"还没回填"，交给调用方提示去跑 builder
  // **写入方要豁免这一条**：新开一版口径时，表里当然还没有这一版的行——builder 正是来
  // 创建它的。第一次升版就撞到了：守卫把 builder 自己挡在门外，于是那一版永远建不出来。
  // 守卫要防的是**读取方**拿着新口径去读旧数据（那会静默返回空基准）。
  if (!requireCurrentVersion) return;
  const mine = db
    .prepare("SELECT COUNT(*) c FROM market_baseline_daily WHERE calc_version = ?")
    .get(BASELINE_CALC_VERSION).c;
  if (!mine) {
    const known = db
      .prepare("SELECT calc_version v, COUNT(*) c FROM market_baseline_daily GROUP BY v")
      .all()
      .map((r) => `${r.v}(${r.c} 行)`)
      .join("、");
    throw new Error(
      `基准口径已改：当前代码算出来的版本是 ${BASELINE_CALC_VERSION}，表里只有 ${known}。\n` +
        `这不是数据没到，是口径失配。要么把 market-baseline-store.mjs 的口径常量改回去，\n` +
        `要么用新口径重新回填一版（node scripts/build-market-baseline.mjs …）——\n` +
        `**不要删旧行**：旧行是 8-13 以来所有引用基准的结论的依据，删了那些结论就没法复现了。`
    );
  }

  // 坏行检查挂在这里，是因为**每一个读取方都会先调这个函数**——挂在别处就总有脚本绕过去。
  // 这一条是 2026-08-23 补的：在此之前，b03672dc0 的九行 3 小时数据被三个评估脚本
  // 正常读了一个星期，没有任何东西吭一声（HANDOFF ㉜）。
  assertNoTruncatedTail(db);
}
