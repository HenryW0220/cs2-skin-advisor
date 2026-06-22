import { getSteamInventory } from "./api/steam";
import { addInventoryItem, findInventoryItemsByName, updateInventoryItem } from "./db/inventory";

export interface IImportSummary {
  totalFromSteam: number;
  imported: number;
  newLots: number;
  backfilled: number;
  unchanged: number;
  skippedNotMarketable: number;
  error?: string;
}

// 同一个饰品可能分批买入、每批价格不一样，所以不会简单地"已存在就跳过"：
// - 第一次见到的饰品，新建一条记录（成本价未知先填 0）
// - 已经记录的数量比 Steam 库存里少，说明又买了一批，按差额新建一条记录（同样成本价未知）
// - 已经记录的数量够了，不新建，只是顺手把缺失的中文名/图标补上
// 不会处理"数量变少"的情况（用户卖了多少不会自动猜，得自己用 DELETE 删掉对应批次）。
// 不可在市场交易的（贴纸涂装以外、印花收藏品之类 marketable=0 的）跳过，跟"交易决策"无关。
export async function importSteamInventory(steamId: string): Promise<IImportSummary> {
  const result = await getSteamInventory(steamId);
  if (result.error || !result.data) {
    return {
      totalFromSteam: 0,
      imported: 0,
      newLots: 0,
      backfilled: 0,
      unchanged: 0,
      skippedNotMarketable: 0,
      error: result.error,
    };
  }

  let imported = 0;
  let newLots = 0;
  let backfilled = 0;
  let unchanged = 0;
  let skippedNotMarketable = 0;

  for (const item of result.data) {
    if (!item.marketable) {
      skippedNotMarketable += 1;
      continue;
    }

    const existingLots = findInventoryItemsByName(item.marketHashName);
    if (existingLots.length === 0) {
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
      continue;
    }

    for (const lot of existingLots) {
      if (!lot.name_cn || !lot.icon_url) {
        updateInventoryItem(lot.id, { name_cn: item.nameCn, icon_url: item.iconUrl });
      }
    }
    backfilled += 1;

    const existingTotalQty = existingLots.reduce((sum, lot) => sum + lot.quantity, 0);
    if (item.quantity > existingTotalQty) {
      addInventoryItem({
        item_name: item.marketHashName,
        name_cn: item.nameCn,
        icon_url: item.iconUrl,
        platform: "steam",
        buy_price: 0,
        quantity: item.quantity - existingTotalQty,
        buy_date: new Date().toISOString().slice(0, 10),
        notes: "从 Steam 库存同步发现新增数量，成本未知，请用 PATCH /api/inventory/:id 修正购入价",
      });
      newLots += 1;
    } else {
      unchanged += 1;
    }
  }

  return {
    totalFromSteam: result.data.length,
    imported,
    newLots,
    backfilled,
    unchanged,
    skippedNotMarketable,
  };
}
