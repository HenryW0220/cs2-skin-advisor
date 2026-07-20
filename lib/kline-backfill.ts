import { getKline } from "./api/steamdt";
import { listInventory } from "./db/inventory";
import { insertPriceSnapshot } from "./db/snapshots";
import { listWatchlist } from "./db/watchlist";
import { pickReferencePlatform } from "./signal-summary";

export interface IKlineBackfillError {
  itemName: string;
  error: string;
}

export interface IKlineBackfillSummary {
  itemCount: number;
  snapshotCount: number;
  skippedNoPlatform: number; // 保留字段：现在有 C5 兜底平台，正常不会再跳过
  errors: IKlineBackfillError[];
}

// kline 接口没有批量版本，串行请求之间留个间隔，别把这个饰品数量级的单品接口打成突发流量。
const REQUEST_DELAY_MS = 250;

// 还没有任何价格快照的饰品（刚加进观察池）找不到参考平台，用 C5 兜底——
// 跟 pickReferencePlatform 的优先级第一位保持一致，回填出来的历史立刻可用。
const FALLBACK_PLATFORM = "C5";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 单个饰品回填最近 90 天的小时级 K 线（加入观察池时立即调用，让新品马上有完整历史）。
// kline 每次固定返回最近 90 天的整点小时线（实测确认，见 lib/types.ts 的 ISteamDTKlinePoint
// 注释），不是文档说的"日线"，也不能指定更早的起始时间。
export async function backfillKlineForItem(
  itemName: string
): Promise<{ snapshotCount: number; error?: string }> {
  const platform = pickReferencePlatform(itemName) ?? FALLBACK_PLATFORM;

  const result = await getKline(itemName, { platform });
  if (result.error || !result.data) {
    return { snapshotCount: 0, error: result.error ?? "无数据" };
  }

  let snapshotCount = 0;
  for (const [timestampSec, , , , close] of result.data) {
    insertPriceSnapshot({
      item_name: itemName,
      platform,
      price: close,
      volume: null,
      captured_at: new Date(Number(timestampSec) * 1000).toISOString(),
    });
    snapshotCount += 1;
  }
  return { snapshotCount };
}

// 批量回填持仓+观察池的全部饰品，写回 price_snapshots 后立刻能被
// computeSignalSummary 现有的 MA/RSI 计算用上，不需要额外改信号计算逻辑。
export async function backfillInventoryKline(): Promise<IKlineBackfillSummary> {
  const names = new Set<string>();
  for (const item of listInventory()) names.add(item.item_name);
  for (const item of listWatchlist()) names.add(item.item_name);
  const itemNames = [...names];

  let snapshotCount = 0;
  const errors: IKlineBackfillError[] = [];

  for (const itemName of itemNames) {
    const result = await backfillKlineForItem(itemName);
    snapshotCount += result.snapshotCount;
    if (result.error) errors.push({ itemName, error: result.error });
    await sleep(REQUEST_DELAY_MS);
  }

  return { itemCount: itemNames.length, snapshotCount, skippedNoPlatform: 0, errors };
}
