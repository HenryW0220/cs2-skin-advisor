import { addAnomalyEvent, hasRecentAnomalyEvent } from "./db/anomaly-events";
import { listInventory } from "./db/inventory";
import { listItemMetadata } from "./db/item-metadata";
import { getPriceHistory } from "./db/snapshots";
import { listWatchlist } from "./db/watchlist";
import { detectPriceZScoreAnomaly, scanPriceZScoreAnomalies } from "./signals/anomaly";
import { computeManipulationScore } from "./signals/manipulation-score";
import { detectVolumeAnomaly } from "./signals/volume";
import { pickReferencePlatform } from "./signal-summary";

export interface IAnomalyScanSummary {
  itemsScanned: number;
  eventsCreated: number;
}

// 每次价格同步后跑一遍：统计异常检测（价格 z-score + 成交量倍数）+ 操盘嫌疑分预警 +
// 同收藏品联动预警，命中就落 pending 的 anomaly_events，等用户去 /anomalies 审核。
// 扫描范围是持仓+观察池（观察池就是数据面扩容入口，见 PLAN.md A3）。
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

// 嫌疑分/联动是"状态"型预警（分数会持续高位好几天），不像 z-score 是"事件"型——
// 同一饰品在窗口期内只提醒一次，不然每小时扫描一次就刷屏了。
const ALERT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const MANIPULATION_ALERT_MIN_SCORE = 60;

function getTrackedItemNames(): string[] {
  const names = new Set<string>();
  for (const item of listInventory()) names.add(item.item_name);
  for (const item of listWatchlist()) names.add(item.item_name);
  return [...names];
}

export function scanForAnomalies(): IAnomalyScanSummary {
  const itemNames = getTrackedItemNames();
  const cooldownSince = new Date(Date.now() - ALERT_COOLDOWN_MS).toISOString();
  let eventsCreated = 0;

  // 本轮触发了异动的饰品（z-score 或嫌疑分），给联动预警当输入
  const triggered = new Map<string, { label: string; value: number }>();
  // 各饰品最新快照，联动预警给下级饰品落事件时要用它的时间点和价格
  const latestByItem = new Map<string, { platform: string; captured_at: string; price: number }>();

  for (const itemName of itemNames) {
    const platform = pickReferencePlatform(itemName);
    if (!platform) continue;

    const history = getPriceHistory(itemName, platform);
    if (history.length === 0) continue;

    const latest = history[history.length - 1];
    latestByItem.set(itemName, { platform, captured_at: latest.captured_at, price: latest.price });
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
      if (created) {
        eventsCreated += 1;
        triggered.set(itemName, { label: `z-score ${priceResult.zScore.toFixed(1)}`, value: priceResult.zScore });
      }
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

    // 操盘嫌疑分预警（B4）：波动形态跟已确认操盘期高度相似时主动提醒
    const manipulation = computeManipulationScore(prices);
    if (
      manipulation &&
      manipulation.score >= MANIPULATION_ALERT_MIN_SCORE &&
      !hasRecentAnomalyEvent(itemName, "manipulation_score", cooldownSince)
    ) {
      const created = addAnomalyEvent({
        item_name: itemName,
        platform,
        metric: "manipulation_score",
        detected_at: latest.captured_at,
        value: manipulation.score,
        price: latest.price,
        context: `24h波动率 ${(manipulation.volatility24h * 100).toFixed(2)}%、24h涨跌 ${(manipulation.move24h * 100).toFixed(1)}%、偏离周线均值 ${(manipulation.maDeviation * 100).toFixed(1)}%`,
      });
      if (created) {
        eventsCreated += 1;
        triggered.set(itemName, { label: `嫌疑分 ${manipulation.score}`, value: manipulation.score });
      }
    }
  }

  // 联动预警（B3）：同收藏品上级异动 → 下级（炼金料）可能跟涨。
  // 用户的经验规律："上级被拉时，下级因为可以炼金成上级而跟涨"，这里把它变成可执行信号。
  const metaByName = new Map(listItemMetadata().map((m) => [m.item_name, m]));
  for (const [triggerName, trigger] of triggered) {
    const triggerMeta = metaByName.get(triggerName);
    if (!triggerMeta?.collection || triggerMeta.rarity_rank === null) continue;

    for (const itemName of itemNames) {
      if (itemName === triggerName || triggered.has(itemName)) continue;
      const meta = metaByName.get(itemName);
      if (
        meta?.collection !== triggerMeta.collection ||
        meta.rarity_rank === null ||
        meta.rarity_rank >= triggerMeta.rarity_rank
      ) {
        continue;
      }
      const latest = latestByItem.get(itemName);
      if (!latest || hasRecentAnomalyEvent(itemName, "collection_linkage", cooldownSince)) continue;

      const created = addAnomalyEvent({
        item_name: itemName,
        platform: latest.platform,
        metric: "collection_linkage",
        detected_at: latest.captured_at,
        value: trigger.value,
        price: latest.price,
        context: `同收藏品「${triggerMeta.collection}」的上级 ${triggerName}（${triggerMeta.rarity ?? ""}）异动（${trigger.label}），本品是下级炼金料，可能跟涨`,
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
  const itemNames = getTrackedItemNames();
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
