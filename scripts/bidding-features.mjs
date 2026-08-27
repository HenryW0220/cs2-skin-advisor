// 求购深度（需求侧挂单厚度）的特征定义，**只此一份**。
//
// 为什么抽出来：HANDOFF 第四节 0.5 记的那条——同名特征在两个地方各写一份，一开始可能
// 完全一致（所以"核对当前是否一致"的检查测不出来），到某一次**单边修改**时才分岔，
// 而做那次修改的人不知道有第二份。基准的定型规则就是这么分岔的（store 那份升版加了
// whole-day-only，report 里重写的那份没跟上，于是误判并指挥人白跑一轮 builder）。
//
// 所以 `analyze-bidding-depth-features.mjs`（操盘标注口径）和
// `build-t7-bidding-baseline.mjs`（T+7 自动标签口径）共用这里的实现。
// 两个脚本的**样本口径和标签不同**（那是有意的），但**特征公式必须是同一份**——
// 否则"标注口径下 bidRatio 有效"和"T+7 口径下 bidRatio 无效"这种对比根本不成立。
//
// ---- 数据的硬约束，用之前必须知道 ----
// 1. 求购字段 2026-07-20 才入库（迁移 013），**历史永远补不了**：K 线不带量、也不带挂单。
// 2. `captured_at` 存的是平台 updateTime（那条报价最后一次变动的时间），不是观测时间，
//    冷门品会留在很早的时间戳上——所以必须按 `captured_at >= BIDDING_DATA_START` 过滤，
//    否则会混进一批陈旧时间戳。
// 3. 参考平台**不能沿用 C5 优先**那套（`market-baseline-store.mjs` 的 PLATFORM_PRIORITY）：
//    那是价格口径。这里按"哪个平台的求购数据最多"选，理由是各平台返回求购字段的
//    完整度差别很大。**这是一处有意的口径分岔，不是疏漏**——它意味着同一个饰品在
//    价格口径和求购口径下可能取了不同平台，做跨口径比较时要记得这件事。

export const BIDDING_DATA_START = "2026-07-20";
export const MA_WINDOW_HOURS = 168; // 跟 lib/signals 的小时桶口径一致（踩坑 45）
export const MIN_ROWS_PER_ITEM = 100; // 少于这个数算不出 168 小时基线，直接跳过

/** 特征清单。key 要跟 computeBiddingFeatures 返回的字段对得上。 */
export const BIDDING_FEATURES = [
  ["bidCount", "求购挂单数（原始值）"],
  ["bidRatio", "求购数 / 自身168h均值"],
  ["bidAskRatio", "求购数 / 在售数（买卖盘厚度比）"],
  ["bidAskRatioRel", "买卖盘厚度比 / 自身168h均值"],
  ["bidSpread", "(在售价-求购价)/在售价，买卖价差"],
  ["bidCountChg24h", "求购数24小时变化率"],
];

/** 按"求购数据最多"选参考平台。沿用 C5 优先会让绝大多数饰品拿不到求购数据。 */
export function biddingPlatform(db, itemName, minRows = MIN_ROWS_PER_ITEM, until = null) {
  const row = db
    .prepare(
      `SELECT platform, COUNT(*) n FROM price_snapshots
       WHERE item_name = ? AND bidding_count IS NOT NULL AND price > 0 AND captured_at >= ?
         AND (? IS NULL OR captured_at < ?)
       GROUP BY platform ORDER BY n DESC LIMIT 1`
    )
    .get(itemName, BIDDING_DATA_START, until, until);
  return row && row.n >= minRows ? row.platform : null;
}

/** 同一小时可能有多条（C5 高频 tick），只留每小时最后一条，跟 lib/signals/resample.ts 同口径。 */
export function biddingHourlySeries(db, itemName, platform, until = null) {
  const rows = db
    .prepare(
      `SELECT captured_at, price, volume, bidding_price, bidding_count
       FROM price_snapshots
       WHERE item_name = ? AND platform = ? AND price > 0
         AND bidding_count IS NOT NULL AND captured_at >= ?
         AND (? IS NULL OR captured_at < ?)
       ORDER BY captured_at ASC`
    )
    .all(itemName, platform, BIDDING_DATA_START, until, until);
  const byHour = new Map();
  for (const r of rows) {
    byHour.set(Math.floor(Date.parse(r.captured_at) / 36e5) * 36e5, r);
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * 滚动均值。**窗口没填满时按已有的算，但至少要 24 个点**——求购数据总共才一个月出头，
 * 要求填满 168 小时会把最早那一周整个丢掉，而那是样本最稀缺的时候。
 * 不足 24 点返回 null，调用方据此把该小时判为不可用。
 */
export function rollingMean(values, window, index) {
  const from = Math.max(0, index - window);
  const slice = values.slice(from, index);
  if (slice.length < Math.min(window, 24)) return null;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

/**
 * 从一段小时序列里算出第 `i` 个小时的求购特征。
 *
 * @param series biddingHourlySeries 的返回值
 * @param i      下标，必须 ≥ 24（要有 24 小时回看才算得出 bidCountChg24h 和滚动均值）
 * @returns 特征对象；`bidRatio`/`bidAskRatioRel` 在基线算不出时取 1（= 与自身基线持平，
 *          中性值），这样它们不会被误当成异常高或异常低。
 */
export function computeBiddingFeatures(series, i, precomputed = null) {
  const bidCounts = precomputed?.bidCounts ?? series.map(([, r]) => r.bidding_count ?? 0);
  const bidAsk =
    precomputed?.bidAsk ??
    series.map(([, r]) => {
      const ask = r.volume ?? 0;
      return ask > 0 ? (r.bidding_count ?? 0) / ask : 0;
    });

  const [, row] = series[i];
  const bidMean = rollingMean(bidCounts, MA_WINDOW_HOURS, i);
  const bidAskMean = rollingMean(bidAsk, MA_WINDOW_HOURS, i);
  const prev24 = bidCounts[i - 24];

  return {
    bidCount: bidCounts[i],
    bidRatio: bidMean && bidMean > 0 ? bidCounts[i] / bidMean : 1,
    bidAskRatio: bidAsk[i],
    bidAskRatioRel: bidAskMean && bidAskMean > 0 ? bidAsk[i] / bidAskMean : 1,
    bidSpread:
      row.price > 0 && row.bidding_price != null ? (row.price - row.bidding_price) / row.price : 0,
    bidCountChg24h: prev24 > 0 ? (bidCounts[i] - prev24) / prev24 : 0,
  };
}

/** 把整段序列的两个派生数组算一次，交给 computeBiddingFeatures 复用（避免 O(n²)）。 */
export function precomputeSeries(series) {
  return {
    bidCounts: series.map(([, r]) => r.bidding_count ?? 0),
    bidAsk: series.map(([, r]) => {
      const ask = r.volume ?? 0;
      return ask > 0 ? (r.bidding_count ?? 0) / ask : 0;
    }),
  };
}
