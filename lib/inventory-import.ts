import { getSteamInventory } from "./api/steam";
import { addInventoryItem, findInventoryItemByName, updateInventoryItem } from "./db/inventory";

export interface IImportSummary {
  totalFromSteam: number;
  imported: number;
  backfilled: number;
  skippedExisting: number;
  skippedNotMarketable: number;
  error?: string;
}

// 已经在 inventory 表里的饰品（按 item_name 判断）不会重复插入，但如果中文名/图标缺失
// （比如这条记录是在加这两个字段之前导入的）会顺手补上，不会动用户已经改过的购入价。
// 不可在市场交易的（贴纸涂装以外、印花收藏品之类 marketable=0 的）跳过，跟"交易决策"无关。
// 新饰品成本价不知道，先填 0，导入后要用户自己用 PATCH /api/inventory/:id 改成真实购入价。
export async function importSteamInventory(steamId: string): Promise<IImportSummary> {
  const result = await getSteamInventory(steamId);
  if (result.error || !result.data) {
    return {
      totalFromSteam: 0,
      imported: 0,
      backfilled: 0,
      skippedExisting: 0,
      skippedNotMarketable: 0,
      error: result.error,
    };
  }

  let imported = 0;
  let backfilled = 0;
  let skippedExisting = 0;
  let skippedNotMarketable = 0;

  for (const item of result.data) {
    if (!item.marketable) {
      skippedNotMarketable += 1;
      continue;
    }

    const existing = findInventoryItemByName(item.marketHashName);
    if (existing) {
      if (!existing.name_cn || !existing.icon_url) {
        updateInventoryItem(existing.id, { name_cn: item.nameCn, icon_url: item.iconUrl });
        backfilled += 1;
      } else {
        skippedExisting += 1;
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
    });
    imported += 1;
  }

  return {
    totalFromSteam: result.data.length,
    imported,
    backfilled,
    skippedExisting,
    skippedNotMarketable,
  };
}
