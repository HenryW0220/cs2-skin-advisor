import { getProductPrices } from "./api/c5";
import { getBatchPrice } from "./api/steamdt";
import { scanForAnomalies } from "./anomaly-scan";
import { insertPriceSnapshot } from "./db/snapshots";
import { runPaperTradingTick } from "./paper-trading";
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

  const c5Result = await getProductPrices(itemNames);
  if (c5Result.error || !c5Result.data) {
    for (const itemName of itemNames) {
      errors.push({ itemName, source: "c5", error: c5Result.error ?? "无数据" });
    }
  } else {
    for (const itemName of itemNames) {
      const entry = c5Result.data[itemName];
      if (!entry) {
        errors.push({ itemName, source: "c5", error: "批量响应里没有这个饰品" });
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

  // 价格写完再扫异常：z-score/成交量基线都是从 price_snapshots 里查历史算的，
  // 得先看到这一轮刚写入的最新快照才能判断"最新一期"正不正常。
  const { eventsCreated } = await scanForAnomalies();

  // 模拟盘也要在最新快照落库后跑，开仓/平仓价才是这一轮的价格。
  const paper = runPaperTradingTick();

  return {
    itemCount: itemNames.length,
    snapshotCount,
    errors,
    anomaliesDetected: eventsCreated,
    paperTradesOpened: paper.opened,
    paperTradesClosed: paper.closed,
  };
}
