import { getProductPrices } from "./api/c5";
import { getBatchPrice } from "./api/steamdt";
import { scanForAnomalies } from "./anomaly-scan";
import { EXCLUDED_PLATFORMS, insertPriceSnapshot } from "./db/snapshots";
import { runPaperTradingTick } from "./paper-trading";
import { precomputeSignalSummaries } from "./signal-precompute";
import { getTrackedItemNames } from "./tracked-items";

export interface ISyncError {
  itemName: string;
  source: "steamdt" | "c5";
  error: string;
}

export interface ISyncSummary {
  itemCount: number;
  snapshotCount: number;
  errors: ISyncError[];
  anomaliesDetected: number;
  paperTradesOpened: number;
  paperTradesClosed: number;
}

// syncPriceSnapshots 和 syncC5PricesOnly（C5 高频 tick，见下）都要把 getProductPrices
// 的分块结果落库，抽成共享函数避免"部分成功时只把没返回的饰品记错误"这段逻辑
// 在两处各写一份、以后改一个忘了改另一个。
async function applyC5Prices(
  itemNames: string[],
  c5Result: Awaited<ReturnType<typeof getProductPrices>>,
  capturedAt: string
): Promise<{ snapshotCount: number; errors: ISyncError[] }> {
  let snapshotCount = 0;
  const errors: ISyncError[] = [];

  if (c5Result.data) {
    for (const itemName of itemNames) {
      const entry = c5Result.data[itemName];
      if (!entry) {
        if (!c5Result.error) errors.push({ itemName, source: "c5", error: "批量响应里没有这个饰品" });
        continue;
      }
      insertPriceSnapshot({
        item_name: itemName,
        // 跟 SteamDT 聚合数据里的 "C5" 平台名对齐（大写），不然会被当成两个不同平台。
        platform: "C5",
        price: entry.price,
        volume: entry.count,
        captured_at: capturedAt,
      });
      snapshotCount += 1;
    }
  }
  if (c5Result.error) {
    const c5Returned = c5Result.data ?? {};
    for (const itemName of itemNames) {
      if (!(itemName in c5Returned)) {
        errors.push({ itemName, source: "c5", error: c5Result.error });
      }
    }
  }

  return { snapshotCount, errors };
}

// C5 批量报价接口没有 SteamDT 那种"每分钟1次"的硬限流（实测 50 QPS 额度很宽松，见
// lib/api/c5.ts 的 globalLimiter），独立于整点全量同步之外单独提高 C5 这一路的刷新
// 频率——只写快照，不跑异常扫描/模拟盘/信号预计算（那三样跟着整点大同步走，避免
// 高频 tick 意外把扫描负载和模拟盘开平仓节奏也一起放大）。lib/signals/resample.ts
// 的小时重采样已经保证这批高频快照不会污染信号计算的"数组下标=小时"假设。
export async function syncC5PricesOnly(): Promise<{
  itemCount: number;
  snapshotCount: number;
  errors: ISyncError[];
}> {
  const itemNames = getTrackedItemNames();
  if (itemNames.length === 0) {
    return { itemCount: 0, snapshotCount: 0, errors: [] };
  }

  const capturedAt = new Date().toISOString();
  const c5Result = await getProductPrices(itemNames);
  const { snapshotCount, errors } = await applyC5Prices(itemNames, c5Result, capturedAt);

  return { itemCount: itemNames.length, snapshotCount, errors };
}

// 手动触发的全量价格刷新：SteamDT 和 C5 各批量查一次（不是每个饰品单独调），写进 price_snapshots。
// 某个数据源整体失败不影响另一个，失败原因收集到 errors 里返回给调用方。
export async function syncPriceSnapshots(): Promise<ISyncSummary> {
  const itemNames = getTrackedItemNames();
  const capturedAt = new Date().toISOString();
  let snapshotCount = 0;
  const errors: ISyncError[] = [];

  if (itemNames.length === 0) {
    return {
      itemCount: 0,
      snapshotCount: 0,
      errors: [],
      anomaliesDetected: 0,
      paperTradesOpened: 0,
      paperTradesClosed: 0,
    };
  }

  // getBatchPrice 分块请求时可能部分成功（比如第二块被限流），data 和 error 会同时有值：
  // 先把拿到的都写进去，再把没出现在返回里的饰品记为错误。
  const steamDtResult = await getBatchPrice(itemNames);
  const steamDtReturned = new Set<string>();
  if (steamDtResult.data) {
    for (const item of steamDtResult.data) {
      steamDtReturned.add(item.marketHashName);
      for (const platformPrice of item.dataList) {
        if ((EXCLUDED_PLATFORMS as readonly string[]).includes(platformPrice.platform)) continue;
        insertPriceSnapshot({
          item_name: item.marketHashName,
          platform: platformPrice.platform,
          price: platformPrice.sellPrice,
          volume: platformPrice.sellCount,
          bidding_price: platformPrice.biddingPrice,
          bidding_count: platformPrice.biddingCount,
          captured_at: platformPrice.updateTime
            ? new Date(platformPrice.updateTime * 1000).toISOString()
            : capturedAt,
        });
        snapshotCount += 1;
      }
    }
  }
  if (steamDtResult.error) {
    for (const itemName of itemNames) {
      if (!steamDtReturned.has(itemName)) {
        errors.push({ itemName, source: "steamdt", error: steamDtResult.error });
      }
    }
  }

  // getProductPrices 分块请求时可能部分成功（比如第三块参数超限），data 和 error 会
  // 同时有值：applyC5Prices 里先把拿到的都写进去，再把没出现在返回 map 里的饰品记为错误。
  const c5Result = await getProductPrices(itemNames);
  const c5Applied = await applyC5Prices(itemNames, c5Result, capturedAt);
  snapshotCount += c5Applied.snapshotCount;
  errors.push(...c5Applied.errors);

  // 价格写完再扫异常：z-score/成交量基线都是从 price_snapshots 里查历史算的，
  // 得先看到这一轮刚写入的最新快照才能判断"最新一期"正不正常。
  const { eventsCreated } = await scanForAnomalies();

  // 模拟盘也要在最新快照落库后跑，开仓/平仓价才是这一轮的价格。
  const paper = runPaperTradingTick();

  // 持仓/观察池页面读的信号汇总表，跟着这一轮最新价格重算一遍（见 lib/signal-precompute.ts）。
  precomputeSignalSummaries(itemNames);

  return {
    itemCount: itemNames.length,
    snapshotCount,
    errors,
    anomaliesDetected: eventsCreated,
    paperTradesOpened: paper.opened,
    paperTradesClosed: paper.closed,
  };
}
