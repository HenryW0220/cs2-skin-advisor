import { getDb } from "./client";
import type { IInventoryItem } from "../types";

export function listInventory(): IInventoryItem[] {
  return getDb()
    .prepare("SELECT * FROM inventory ORDER BY created_at DESC")
    .all() as IInventoryItem[];
}

export function getInventoryItem(id: number): IInventoryItem | undefined {
  return getDb()
    .prepare("SELECT * FROM inventory WHERE id = ?")
    .get(id) as IInventoryItem | undefined;
}

export function addInventoryItem(
  item: Pick<
    IInventoryItem,
    "item_name" | "platform" | "buy_price" | "quantity" | "buy_date" | "notes"
  > &
    Partial<Pick<IInventoryItem, "name_cn" | "icon_url" | "steam_asset_id">>
): IInventoryItem {
  const result = getDb()
    .prepare(
      `INSERT INTO inventory (item_name, name_cn, icon_url, platform, buy_price, quantity, buy_date, notes, steam_asset_id)
       VALUES (@item_name, @name_cn, @icon_url, @platform, @buy_price, @quantity, @buy_date, @notes, @steam_asset_id)`
    )
    .run({ name_cn: null, icon_url: null, steam_asset_id: null, ...item });
  return getInventoryItem(result.lastInsertRowid as number)!;
}

export function deleteInventoryItem(id: number): void {
  getDb().prepare("DELETE FROM inventory WHERE id = ?").run(id);
}

export function updateInventoryItem(
  id: number,
  fields: Partial<
    Pick<IInventoryItem, "buy_price" | "quantity" | "buy_date" | "notes" | "name_cn" | "icon_url">
  >
): IInventoryItem | undefined {
  const current = getInventoryItem(id);
  if (!current) return undefined;

  // 过滤掉 undefined，不然 {...current, ...fields} 会把没传的字段也覆盖成 undefined。
  const definedFields = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
  const next = { ...current, ...definedFields };
  getDb()
    .prepare(
      `UPDATE inventory
       SET buy_price = @buy_price, quantity = @quantity, buy_date = @buy_date,
           notes = @notes, name_cn = @name_cn, icon_url = @icon_url, updated_at = datetime('now')
       WHERE id = @id`
    )
    .run({
      id,
      buy_price: next.buy_price,
      quantity: next.quantity,
      buy_date: next.buy_date,
      notes: next.notes,
      name_cn: next.name_cn,
      icon_url: next.icon_url,
    });
  return getInventoryItem(id);
}

// 同一个 item_name 可以有多条记录（不同批次/不同 Steam asset，价格可能不一样），没有唯一约束。
export function findInventoryItemsByName(itemName: string): IInventoryItem[] {
  return getDb()
    .prepare("SELECT * FROM inventory WHERE item_name = ?")
    .all(itemName) as IInventoryItem[];
}

// 按 Steam 真实 asset id 查找，导入时用来判断这个具体物品是不是已经同步过了。
export function findInventoryItemBySteamAssetId(assetId: string): IInventoryItem | undefined {
  return getDb()
    .prepare("SELECT * FROM inventory WHERE steam_asset_id = ?")
    .get(assetId) as IInventoryItem | undefined;
}

// Steam 导入的行（steam_asset_id 非空），同步时拿来对比最新库存、找出已卖出/转移的资产。
// 手动添加的持仓（steam_asset_id 为 null）不在此列，永远不会被自动清理。
export function listSteamLinkedInventory(): IInventoryItem[] {
  return getDb()
    .prepare("SELECT * FROM inventory WHERE steam_asset_id IS NOT NULL")
    .all() as IInventoryItem[];
}
