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
// ⚠️ **已知缺陷，还没修，修它要新开一版口径**（2026-08-14 发现）：
// 下面 ensureBaselines 的定型检查是**逐小时** `break` 的，但写库是**整天**写的。
// 后果是**卡在定型边界上的那一天会被写成半天，而且从此不再重算**（storedDays 认为它有了）。
// 实测：生产库里窗口 7 天的 2026-08-06 只有 14 小时样本（4550/325），完整应是 24 小时；
// 用完整数据重算得到 −2.38%，库里存的是 −2.14%。**每次回填的最后一天都有这个问题**
// （8 个窗口各一天，858 行里 8 行）。
// **为什么不顺手修**：修了会改变那些行的数字，按迁移 024 定的规矩，改变数字 = 新开一版
// calc_version 并整体重算，旧行保留。那是一次要项目所有者拍板的动作（会牵动已经报出去的
// +16.79% 等数字），不能在一次顺手提交里做掉。
// **已经做的止血**：`--daily` 模式按"当天最后一小时是否定型"选日子，所以**往后不会再产生
// 新的半天行**；存量那 8 行原样保留，等口径升版时一起重算。
// 注意：多数天的样本数不到 24 小时/饰品是**另一回事**（采集本身有缺口，同一小时两端都要有价
// 才算一个样本），那是数据密度不是这个缺陷，别混。
//
// ⚠️ 只有**会影响数字**的东西才能进这个对象。脚本改注释、改性能不该让整表失效，
// 所以 script_sha 只记在 meta 里做取证，不参与指纹。反过来，任何改了数值口径的改动
// （包括中位数在偶数样本上的取法）**必须**在这里显式登记，否则新旧两套会混进同一版。
export const BASELINE_CALIBER = {
  historyGateHours: "24*(horizon+14)",
  itemUniverse: "DISTINCT item_name FROM price_snapshots",
  medianRule: "even-count=mean-of-two-middles",
  minSamplesPerDay: MIN_SAMPLES_PER_DAY,
  minSnapshotsPerItem: MIN_SNAPSHOTS_PER_ITEM,
  platformPriority: PLATFORM_PRIORITY.join(","),
  resample: "hourly-last",
  settleHours: SETTLE_MS / HOUR_MS,
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
  const cutoff = Date.now();

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
        // daily 模式额外要求**整天**都定型了才写。逐小时 break 会让卡在定型边界上的那天
        // 只写进去半天、而且从此不再重算（见文件上方"已知缺陷"）。daily 是每天都会跑的，
        // 晚一天写、写完整的没有任何损失。
        // **全量模式保持原样不动**：改它会改变已有那 8 行边界日的数字，按迁移 024 的规矩
        // 那就得新开一版口径整体重算，是要拍板的动作，不能顺手做掉。
        // 所以两个模式的差别**只有"这一天现在写还是明天写"**，写下去的值完全同口径。
        if (daily) {
          const dayEndMs = Math.floor(ts / DAY_MS) * DAY_MS + DAY_MS - HOUR_MS;
          if (dayEndMs + horizon * DAY_MS + SETTLE_MS > cutoff) break;
        }

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
 */
export function loadBaseline(db, horizon, calcVersion = BASELINE_CALC_VERSION) {
  const rows = db
    .prepare(
      `SELECT day, median_return, sample_count, item_count FROM market_baseline_daily
       WHERE horizon_days = ? AND calc_version = ?`
    )
    .all(horizon, calcVersion);
  return new Map(
    rows.map((r) => [
      Date.parse(`${r.day}T00:00:00.000Z`),
      { median: r.median_return, sampleCount: r.sample_count, itemCount: r.item_count },
    ])
  );
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
export function assertBaselineTable(db) {
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
  const rows = db.prepare("SELECT COUNT(*) c FROM market_baseline_daily").get().c;
  if (!rows) return; // 空表是"还没回填"，交给调用方提示去跑 builder
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
}
