import { addAnomalyEvent } from "./db/anomaly-events";
import { listInventory } from "./db/inventory";
import { getPriceHistory } from "./db/snapshots";
import { detectPriceZScoreAnomaly, scanPriceZScoreAnomalies } from "./signals/anomaly";
import { detectVolumeAnomaly } from "./signals/volume";
import { pickReferencePlatform } from "./signal-summary";

export interface IAnomalyScanSummary {
  itemsScanned: number;
  eventsCreated: number;
}

// 每次价格同步后跑一遍：不需要标签的统计异常检测（价格 z-score + 成交量倍数），
// 命中就落一条 pending 的 anomaly_events，等用户去 /anomalies 页面确认或忽略。
// 只扫持仓（跟 K 线回填、操盘标记的范围保持一致），观察池以后有需要再扩展。
//
// 成交量用的窗口（168 期）比 lib/rules/evaluate.ts 里规则引擎用的默认窗口（7 期）
// 长得多——规则引擎要的是"这一刻要不要决策"的短期信号，这里要的是"相对这个饰品
// 自己的正常水平"的统计基线，窗口太短基线本身就不稳定，异常判断没有意义。
const VOLUME_ANOMALY_WINDOW = 168;
const VOLUME_ANOMALY_THRESHOLD = 3;

// 几分钱的印花/图案这类饰品，价格本身就是一分两分地跳（0.02 -> 0.03 就是 50%），
// 这种"异常"是价格精度太粗糙的机械结果，不是操盘——没人会去操盘一个几分钱的东西。
// 挡在检测之前，而不是事后筛掉：这类饰品占了实测候选事件里很大一部分噪音。
const MIN_PRICE_FOR_ANOMALY_SCAN = 1;

export function scanForAnomalies(): IAnomalyScanSummary {
  const itemNames = [...new Set(listInventory().map((item) => item.item_name))];
  let eventsCreated = 0;

  for (const itemName of itemNames) {
    const platform = pickReferencePlatform(itemName);
    if (!platform) continue;

    const history = getPriceHistory(itemName, platform);
    if (history.length === 0) continue;

    const latest = history[history.length - 1];
    if (latest.price < MIN_PRICE_FOR_ANOMALY_SCAN) continue;
    const prices = history.map((h) => h.price);
    // K 线回填的快照没有成交量（volume 是 null），如果把 null 当 0 计入基线，
    // 均值会被大量 0 拉到接近 0，真实同步一来任何非零成交量都会被算成几十倍的"异常"——
    // 只用真的有成交量数据的快照参与统计，且只在最新一条快照本身有真实成交量时才检测。
    const volumeHistory = history.filter((h) => h.volume !== null);

    const priceResult = detectPriceZScoreAnomaly(prices);
    if (priceResult?.isAnomaly && Number.isFinite(priceResult.zScore)) {
      const created = addAnomalyEvent({
        item_name: itemName,
        platform,
        metric: "price_zscore",
        detected_at: latest.captured_at,
        value: priceResult.zScore,
        price: latest.price,
      });
      if (created) eventsCreated += 1;
    }

    const latestHasVolume = volumeHistory[volumeHistory.length - 1]?.captured_at === latest.captured_at;
    const volumeResult = latestHasVolume
      ? detectVolumeAnomaly(
          volumeHistory.map((h) => h.volume as number),
          { window: VOLUME_ANOMALY_WINDOW, threshold: VOLUME_ANOMALY_THRESHOLD }
        )
      : null;
    if (volumeResult?.isAnomaly && Number.isFinite(volumeResult.ratio)) {
      const created = addAnomalyEvent({
        item_name: itemName,
        platform,
        metric: "volume_ratio",
        detected_at: latest.captured_at,
        value: volumeResult.ratio,
        price: latest.price,
      });
      if (created) eventsCreated += 1;
    }
  }

  return { itemsScanned: itemNames.length, eventsCreated };
}

// 一次性回溯扫描：对每个持仓饰品回填出来的完整历史逐点算价格 z-score（不止最新一点），
// 直接从刚回填的 90 天密集数据里挖出候选异常窗口，不用干等未来再发生一次。
// 只扫价格——成交量的真实数据现在还太少（K 线回填没有成交量，只能慢慢靠每小时同步攒），
// 回溯扫成交量意义不大，见 scanForAnomalies 里的说明。
export function scanHistoricalPriceAnomalies(): IAnomalyScanSummary {
  const itemNames = [...new Set(listInventory().map((item) => item.item_name))];
  let eventsCreated = 0;

  for (const itemName of itemNames) {
    const platform = pickReferencePlatform(itemName);
    if (!platform) continue;

    const history = getPriceHistory(itemName, platform);
    if (history.length === 0) continue;

    const prices = history.map((h) => h.price);
    const results = scanPriceZScoreAnomalies(prices);

    for (const result of results) {
      if (!result.isAnomaly || !Number.isFinite(result.zScore)) continue;
      const snapshot = history[result.priceIndex];
      if (snapshot.price < MIN_PRICE_FOR_ANOMALY_SCAN) continue;
      const created = addAnomalyEvent({
        item_name: itemName,
        platform,
        metric: "price_zscore",
        detected_at: snapshot.captured_at,
        value: result.zScore,
        price: snapshot.price,
      });
      if (created) eventsCreated += 1;
    }
  }

  return { itemsScanned: itemNames.length, eventsCreated };
}
