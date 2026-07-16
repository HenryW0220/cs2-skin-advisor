import { getDb } from "./client";
import type { IWatchlistItem } from "../types";

export function listWatchlist(): IWatchlistItem[] {
  return getDb()
    .prepare("SELECT * FROM watchlist ORDER BY created_at DESC")
    .all() as IWatchlistItem[];
}

export function addWatchlistItem(
  item: Pick<IWatchlistItem, "item_name" | "target_buy_price" | "target_sell_price" | "notes"> &
    Partial<Pick<IWatchlistItem, "name_cn" | "icon_url">>
): IWatchlistItem {
  const result = getDb()
    .prepare(
      `INSERT INTO watchlist (item_name, name_cn, icon_url, target_buy_price, target_sell_price, notes)
       VALUES (@item_name, @name_cn, @icon_url, @target_buy_price, @target_sell_price, @notes)`
    )
    .run({ name_cn: null, icon_url: null, ...item });
  return getDb()
    .prepare("SELECT * FROM watchlist WHERE id = ?")
    .get(result.lastInsertRowid) as IWatchlistItem;
}

export function removeWatchlistItem(id: number): void {
  getDb().prepare("DELETE FROM watchlist WHERE id = ?").run(id);
}
