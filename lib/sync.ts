import { getProductPrice } from "./api/c5";
import { getSinglePrice } from "./api/steamdt";
import { listInventory } from "./db/inventory";
import { insertPriceSnapshot } from "./db/snapshots";
import { listWatchlist } from "./db/watchlist";

export interface ISyncError {
  itemName: string;
  source: "steamdt" | "c5";
  error: string;
}

export interface ISyncSummary {
  itemCount: number;
  snapshotCount: number;
  errors: ISyncError[];
}

function getTrackedItemNames(): string[] {
  const names = new Set<string>();
  for (const item of listInventory()) names.add(item.item_name);
  for (const item of listWatchlist()) names.add(item.item_name);
  return [...names];
}

// 手动触发的全量价格刷新：对持仓 + 观察池里的每个饰品，分别查 SteamDT 和 C5，写进 price_snapshots。
// 单个饰品某个数据源失败不会中断整体流程，失败原因收集到 errors 里返回给调用方。
export async function syncPriceSnapshots(): Promise<ISyncSummary> {
  const itemNames = getTrackedItemNames();
  const capturedAt = new Date().toISOString();
  let snapshotCount = 0;
  const errors: ISyncError[] = [];

  for (const itemName of itemNames) {
    const steamDtResult = await getSinglePrice(itemName);
    if (steamDtResult.error || !steamDtResult.data) {
      errors.push({
        itemName,
        source: "steamdt",
        error: steamDtResult.error ?? "无数据",
      });
    } else {
      for (const platformPrice of steamDtResult.data) {
        insertPriceSnapshot({
          item_name: itemName,
          platform: platformPrice.platform,
          price: platformPrice.sellPrice,
          volume: platformPrice.sellCount,
          captured_at: platformPrice.updateTime || capturedAt,
        });
        snapshotCount += 1;
      }
    }

    const c5Result = await getProductPrice(itemName);
    if (c5Result.error || !c5Result.data) {
      errors.push({ itemName, source: "c5", error: c5Result.error ?? "无数据" });
    } else {
      insertPriceSnapshot({
        item_name: itemName,
        platform: "c5",
        price: c5Result.data.price,
        volume: null,
        captured_at: capturedAt,
      });
      snapshotCount += 1;
    }
  }

  return { itemCount: itemNames.length, snapshotCount, errors };
}
