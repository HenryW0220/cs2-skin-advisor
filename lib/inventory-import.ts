import { getSteamInventory } from "./api/steam";
import {
  addInventoryItem,
  findInventoryItemBySteamAssetId,
  updateInventoryItem,
} from "./db/inventory";

export interface IImportSummary {
  totalFromSteam: number;
  imported: number;
  backfilled: number;
  skippedNotMarketable: number;
  error?: string;
}

// 每个 Steam 资产（asset）独立成一行，按 steam_asset_id 去重——不再按 marketHashName
// 合并数量再猜差额，因为 Steam 根本不告诉我们每个 asset 的购入价，猜数量变化没有意义，
// 不如如实展示"这个饰品有几个独立资产"，让用户自己决定要不要在 UI 里合并显示。
// 不可在市场交易的（贴纸涂装以外、印花收藏品之类 marketable=0 的）跳过，跟"交易决策"无关。
export async function importSteamInventory(steamId: string): Promise<IImportSummary> {
  const result = await getSteamInventory(steamId);
  if (result.error || !result.data) {
    return {
      totalFromSteam: 0,
      imported: 0,
      backfilled: 0,
      skippedNotMarketable: 0,
      error: result.error,
    };
  }

  let imported = 0;
  let backfilled = 0;
  let skippedNotMarketable = 0;

  for (const item of result.data) {
    if (!item.marketable) {
      skippedNotMarketable += 1;
      continue;
    }

    const existing = findInventoryItemBySteamAssetId(item.assetId);
    if (existing) {
      if (!existing.name_cn || !existing.icon_url) {
        updateInventoryItem(existing.id, { name_cn: item.nameCn, icon_url: item.iconUrl });
        backfilled += 1;
      }
      continue;
    }

    addInventoryItem({
      item_name: item.marketHashName,
      name_cn: item.nameCn,
      icon_url: item.iconUrl,
      platform: "steam",
      buy_price: 0,
      quantity: item.quantity,
      buy_date: new Date().toISOString().slice(0, 10),
      notes: "从 Steam 库存自动导入，成本未知，请用 PATCH /api/inventory/:id 修正购入价",
      steam_asset_id: item.assetId,
    });
    imported += 1;
  }

  return {
    totalFromSteam: result.data.length,
    imported,
    backfilled,
    skippedNotMarketable,
  };
}
