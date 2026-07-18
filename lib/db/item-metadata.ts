import { getDb } from "./client";
import type { IItemMetadata } from "../types";

export function upsertItemMetadata(
  meta: Pick<IItemMetadata, "item_name" | "collection" | "crate" | "rarity" | "rarity_rank">
): void {
  getDb()
    .prepare(
      `INSERT INTO item_metadata (item_name, collection, crate, rarity, rarity_rank)
       VALUES (@item_name, @collection, @crate, @rarity, @rarity_rank)
       ON CONFLICT(item_name) DO UPDATE SET
         collection = excluded.collection,
         crate = excluded.crate,
         rarity = excluded.rarity,
         rarity_rank = excluded.rarity_rank,
         updated_at = datetime('now')`
    )
    .run(meta);
}

export function getItemMetadata(itemName: string): IItemMetadata | undefined {
  return getDb()
    .prepare("SELECT * FROM item_metadata WHERE item_name = ?")
    .get(itemName) as IItemMetadata | undefined;
}

export function listItemMetadata(): IItemMetadata[] {
  return getDb().prepare("SELECT * FROM item_metadata").all() as IItemMetadata[];
}

// 同收藏品的其他饰品（联动分析用）；品质从高到低排，"上级"排前面。
export function listItemMetadataByCollection(collection: string): IItemMetadata[] {
  return getDb()
    .prepare(
      "SELECT * FROM item_metadata WHERE collection = ? ORDER BY rarity_rank DESC, item_name ASC"
    )
    .all(collection) as IItemMetadata[];
}
