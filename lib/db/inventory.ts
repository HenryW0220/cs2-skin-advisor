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
    Partial<Pick<IInventoryItem, "name_cn" | "icon_url">>
): IInventoryItem {
  const result = getDb()
    .prepare(
      `INSERT INTO inventory (item_name, name_cn, icon_url, platform, buy_price, quantity, buy_date, notes)
       VALUES (@item_name, @name_cn, @icon_url, @platform, @buy_price, @quantity, @buy_date, @notes)`
    )
    .run({ name_cn: null, icon_url: null, ...item });
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

// 按饰品名查找，导入 Steam 库存时用来判断这个饰品是不是已经手动加过了，避免重复插入。
export function findInventoryItemByName(itemName: string): IInventoryItem | undefined {
  return getDb()
    .prepare("SELECT * FROM inventory WHERE item_name = ? LIMIT 1")
    .get(itemName) as IInventoryItem | undefined;
}
