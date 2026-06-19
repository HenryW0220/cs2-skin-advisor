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
  >
): IInventoryItem {
  const result = getDb()
    .prepare(
      `INSERT INTO inventory (item_name, platform, buy_price, quantity, buy_date, notes)
       VALUES (@item_name, @platform, @buy_price, @quantity, @buy_date, @notes)`
    )
    .run(item);
  return getInventoryItem(result.lastInsertRowid as number)!;
}

export function deleteInventoryItem(id: number): void {
  getDb().prepare("DELETE FROM inventory WHERE id = ?").run(id);
}
