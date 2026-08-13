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
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

// 参考平台优先级跟 lib/signal-summary.ts 一致
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];
const MIN_SNAPSHOTS_PER_ITEM = 200;
// 一天的基准至少要这么多样本才算数——太少的中位数不可信，宁可这一天没有基准。
// 这条是从 report-shadow-sell-signals / report-paper-trades 那边继承来的，
// build-sell-rule-baseline 原来没有这个下限：差别只出现在数据两端样本极少的那几天。
const MIN_SAMPLES_PER_DAY = 20;

// ⚠️ 改了上面任何一条口径（平台优先级、历史长度门槛、样本下限），
// 已经存进 market_baseline_daily 的行**不会自动重算**（增量逻辑只补缺的天）。
// 必须先 DELETE FROM market_baseline_daily 再重跑 builder，否则表里会混着两套口径的数字。
// 收盘之后再等这么久才认为这一天的基准定型：同步偶尔错过整点，留一点余量
const SETTLE_MS = 6 * HOUR_MS;

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

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

function hourlyPrices(db, itemName, platform) {
  const rows = db
    .prepare(
      `SELECT captured_at, price FROM price_snapshots
       WHERE item_name = ? AND platform = ? AND price > 0 ORDER BY captured_at ASC`
    )
    .all(itemName, platform);
  const byHour = new Map();
  for (const r of rows) {
    byHour.set(Math.floor(Date.parse(r.captured_at) / HOUR_MS) * HOUR_MS, r.price);
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]);
}

const dayKey = (ms) => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);

function storedDays(db, horizon) {
  return new Set(
    db
      .prepare("SELECT day FROM market_baseline_daily WHERE horizon_days = ?")
      .all(horizon)
      .map((r) => r.day)
  );
}

/**
 * 增量补齐给定窗口的基准。已经存过的 (天, 窗口) 不重算——价格只追加，
 * 一天的基准在 day + horizon + 6 小时之后就不会再变。
 *
 * @param horizons 要算的窗口天数数组，比如 [7] 或 [7, 12, 14]
 * @returns 每个窗口新写入了多少天
 */
export function ensureBaselines(db, horizons, { verbose = false } = {}) {
  const pending = horizons.filter((h) => Number.isFinite(h) && h > 0);
  if (!pending.length) return {};

  const existing = new Map(pending.map((h) => [h, storedDays(db, h)]));
  const cutoff = Date.now();
  const buckets = new Map(); // `${horizon}|${day}` -> {rets:[], items:Set}

  const items = db
    .prepare("SELECT DISTINCT item_name FROM price_snapshots")
    .all()
    .map((r) => r.item_name);

  for (const item of items) {
    const platform = referencePlatform(db, item);
    if (!platform) continue;
    const series = hourlyPrices(db, item, platform);
    const hourIndex = new Map(series.map(([h], i) => [h, i]));
    for (const horizon of pending) {
      // 历史长度门槛跟 build-sell-rule-baseline.mjs 完全一致（24 × (窗口 + 14) 小时）。
      // **这条必须对齐**：v2 的全部阈值是从那个脚本反推的，参与基准的饰品集合一变，
      // 基准就变、超额就变，那些阈值的依据也就跟着漂了。
      if (series.length < 24 * (horizon + 14)) continue;
      const done = existing.get(horizon);
      for (let i = 0; i < series.length; i++) {
        const [ts, price] = series[i];
        // 这一天的基准要定型才算，否则今天算一半、明天又变
        if (ts + horizon * DAY_MS + SETTLE_MS > cutoff) break;
        const day = dayKey(ts);
        if (done.has(day)) continue;

        const futureIdx = hourIndex.get(ts + horizon * DAY_MS);
        if (futureIdx === undefined) continue;
        const fwd = (series[futureIdx][1] - price) / price;
        if (!Number.isFinite(fwd)) continue;

        const key = `${horizon}|${day}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { rets: [], items: new Set() };
          buckets.set(key, bucket);
        }
        bucket.rets.push(fwd);
        bucket.items.add(item);
      }
    }
  }

  const insert = db.prepare(
    `INSERT INTO market_baseline_daily (day, horizon_days, median_return, sample_count, item_count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, horizon_days) DO UPDATE SET
       median_return = excluded.median_return,
       sample_count = excluded.sample_count,
       item_count = excluded.item_count,
       computed_at = datetime('now')`
  );

  const written = {};
  const writeAll = db.transaction((entries) => {
    for (const [key, bucket] of entries) {
      if (bucket.rets.length < MIN_SAMPLES_PER_DAY) continue;
      const [horizonRaw, day] = key.split("|");
      const horizon = Number(horizonRaw);
      insert.run(day, horizon, median(bucket.rets), bucket.rets.length, bucket.items.size);
      written[horizon] = (written[horizon] ?? 0) + 1;
    }
  });
  writeAll([...buckets.entries()]);

  if (verbose) {
    for (const horizon of pending) {
      console.log(`[market-baseline] 窗口 ${horizon} 天：新写入 ${written[horizon] ?? 0} 天`);
    }
  }
  return written;
}

/** 读出某个窗口的全部基准。key 是当天 00:00 UTC 的毫秒时间戳，跟脚本里 day 的算法对齐。 */
export function loadBaseline(db, horizon) {
  const rows = db
    .prepare(
      "SELECT day, median_return, sample_count, item_count FROM market_baseline_daily WHERE horizon_days = ?"
    )
    .all(horizon);
  return new Map(
    rows.map((r) => [
      Date.parse(`${r.day}T00:00:00.000Z`),
      { median: r.median_return, sampleCount: r.sample_count, itemCount: r.item_count },
    ])
  );
}

/** 表还没建（迁移没跑）时给一句人话，而不是抛一个 no such table。 */
export function assertBaselineTable(db) {
  const row = db
    .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='market_baseline_daily'")
    .get();
  if (!row.c) {
    throw new Error(
      "market_baseline_daily 不存在——迁移 023 还没跑。容器重启一次（进程启动时会自动跑迁移）再来。"
    );
  }
}
