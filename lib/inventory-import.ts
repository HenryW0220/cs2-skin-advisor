import { getSellerOrderList } from "./api/c5";
import { getSteamInventory } from "./api/steam";
import {
  addInventoryItem,
  deleteInventoryItem,
  findInventoryItemBySteamAssetId,
  listSteamLinkedInventory,
  updateInventoryItem,
} from "./db/inventory";
import { addSaleRecord } from "./db/sales";

export interface IImportSummary {
  totalFromSteam: number;
  imported: number;
  backfilled: number;
  removed: number; // Steam 库存里已经没有的资产（卖掉/交易走了），本地对应行被删掉的数量
  skippedNotMarketable: number;
  error?: string;
}

// 最近 14 天内的 C5 卖单按 marketHashName 建价格映射（同名多笔取最新一笔）。
// C5 卖单的 status 枚举文档没写清楚，逐个常见值查一遍，哪个有数据用哪个；
// 整体失败不影响库存同步——价格补不上就留 NULL 让用户手填。
async function fetchRecentC5SalePrices(steamId: string): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const sinceMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const status of [2, 3, 4]) {
    const result = await getSellerOrderList(steamId, { status, limit: 100 });
    for (const order of result.data?.list ?? []) {
      const t = new Date(order.orderCreateTime).getTime();
      if (Number.isFinite(t) && t >= sinceMs && order.price > 0 && !prices.has(order.marketHashName)) {
        prices.set(order.marketHashName, order.price);
      }
    }
    if (prices.size > 0) break;
  }
  return prices;
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
      removed: 0,
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
      notes: "从 Steam 库存自动导入。购入价保持 0 表示自己开箱获得，不计盈亏；花钱买的请在持仓页填真实购入价",
      steam_asset_id: item.assetId,
    });
    imported += 1;
  }

  // 反向清理：本地有、Steam 最新库存里没有的资产，说明已经卖掉或交易走了。
  // seen 用全量资产（含 marketable=0 的）比对，避免误删；getSteamInventory 翻页
  // 中途失败会整体报错并在上面提前返回，不会拿半份列表进到这里。
  // 删行之前先落卖出流水（PLAN.md D2）：卖出价优先从 C5 卖家订单自动匹配，
  // 匹配不到留 NULL，用户在流水页手动补。
  const seenAssetIds = new Set(result.data.map((item) => item.assetId));
  const removedRows = listSteamLinkedInventory().filter(
    (row) => row.steam_asset_id && !seenAssetIds.has(row.steam_asset_id)
  );
  const c5SalePrices = removedRows.length > 0 ? await fetchRecentC5SalePrices(steamId) : new Map();
  let removed = 0;
  for (const row of removedRows) {
    const autoPrice = c5SalePrices.get(row.item_name) ?? null;
    addSaleRecord({
      item_name: row.item_name,
      name_cn: row.name_cn,
      icon_url: row.icon_url,
      quantity: row.quantity,
      buy_price: row.buy_price,
      sell_price: autoPrice,
      sell_source: autoPrice !== null ? "c5_order" : null,
      steam_asset_id: row.steam_asset_id,
    });
    deleteInventoryItem(row.id);
    removed += 1;
  }

  return {
    totalFromSteam: result.data.length,
    imported,
    backfilled,
    removed,
    skippedNotMarketable,
  };
}
