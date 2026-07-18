import { getKline } from "./api/steamdt";
import { listInventory } from "./db/inventory";
import { insertPriceSnapshot } from "./db/snapshots";
import { pickReferencePlatform } from "./signal-summary";

export interface IKlineBackfillError {
  itemName: string;
  error: string;
}

export interface IKlineBackfillSummary {
  itemCount: number;
  snapshotCount: number;
  skippedNoPlatform: number; // 还没同步过价格、找不到参考平台的饰品，没法回填
  errors: IKlineBackfillError[];
}

// kline 接口没有批量版本，串行请求之间留个间隔，别把这个饰品数量级的单品接口打成突发流量。
const REQUEST_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 只回填持仓（不管观察池——按当前需求，训练数据先只用持仓里已确认操盘时间窗口的饰品）。
// 每个饰品用它当前的参考平台（lib/signal-summary.ts 的 pickReferencePlatform）查 kline，
// 写回 price_snapshots 时也存成这个平台，这样立刻能被 computeSignalSummary 现有的
// MA/RSI 计算用上，不需要额外改信号计算逻辑。
//
// kline 每次固定返回最近 90 天的整点小时线（实测确认，见 lib/types.ts 的 ISteamDTKlinePoint
// 注释），不是文档说的"日线"，也不能指定更早的起始时间——所以这只能把"最近 90 天"从粗粒度
// 的手动同步补成稠密的小时级数据，补不出 90 天之前的历史。
export async function backfillInventoryKline(): Promise<IKlineBackfillSummary> {
  const itemNames = [...new Set(listInventory().map((item) => item.item_name))];

  let snapshotCount = 0;
  let skippedNoPlatform = 0;
  const errors: IKlineBackfillError[] = [];

  for (const itemName of itemNames) {
    const platform = pickReferencePlatform(itemName);
    if (!platform) {
      skippedNoPlatform += 1;
      continue;
    }

    const result = await getKline(itemName, { platform });
    if (result.error || !result.data) {
      errors.push({ itemName, error: result.error ?? "无数据" });
    } else {
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
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return { itemCount: itemNames.length, snapshotCount, skippedNoPlatform, errors };
}
