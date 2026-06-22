import { getSteamInventory } from "./api/steam";
import { addInventoryItem, findInventoryItemByName } from "./db/inventory";

export interface IImportSummary {
  totalFromSteam: number;
  imported: number;
  skippedExisting: number;
  skippedNotMarketable: number;
  error?: string;
}

// 已经在 inventory 表里的饰品（按 item_name 判断）跳过，避免重复插入；不可在市场交易的
// （贴纸涂装以外、印花收藏品之类 marketable=0 的）也跳过，跟"交易决策"这个项目目标无关。
// 新饰品成本价不知道，先填 0，导入后要用户自己用 PATCH /api/inventory/:id 改成真实购入价。
export async function importSteamInventory(steamId: string): Promise<IImportSummary> {
  const result = await getSteamInventory(steamId);
  if (result.error || !result.data) {
    return {
      totalFromSteam: 0,
      imported: 0,
      skippedExisting: 0,
      skippedNotMarketable: 0,
      error: result.error,
    };
  }

  let imported = 0;
  let skippedExisting = 0;
  let skippedNotMarketable = 0;

  for (const item of result.data) {
    if (!item.marketable) {
      skippedNotMarketable += 1;
      continue;
    }
    if (findInventoryItemByName(item.marketHashName)) {
      skippedExisting += 1;
      continue;
    }
    addInventoryItem({
      item_name: item.marketHashName,
      platform: "steam",
      buy_price: 0,
      quantity: item.quantity,
      buy_date: new Date().toISOString().slice(0, 10),
      notes: "从 Steam 库存自动导入，成本未知，请用 PATCH /api/inventory/:id 修正购入价",
    });
    imported += 1;
  }

  return {
    totalFromSteam: result.data.length,
    imported,
    skippedExisting,
    skippedNotMarketable,
  };
}
