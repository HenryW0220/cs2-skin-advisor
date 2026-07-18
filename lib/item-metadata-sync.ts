import { fetchItemStructureMap } from "./api/cs-item-db";
import { listInventory } from "./db/inventory";
import { upsertItemMetadata } from "./db/item-metadata";
import { listWatchlist } from "./db/watchlist";

export interface IItemMetadataSyncSummary {
  itemCount: number;
  matched: number;
  unmatched: number; // 印花/探员等不在皮肤数据集里的饰品，属正常情况不算错误
  error?: string;
}

// 给持仓+观察池的所有饰品同步收藏品/品质结构资料。数据集是静态的（新箱子发布才变），
// 偶尔手动触发一次就够；饰品匹配不到也会落一条全 null 的记录，避免下次同步重复判断。
export async function syncItemMetadata(): Promise<IItemMetadataSyncSummary> {
  const names = new Set<string>();
  for (const item of listInventory()) names.add(item.item_name);
  for (const item of listWatchlist()) names.add(item.item_name);

  const result = await fetchItemStructureMap();
  if (result.error || !result.data) {
    return { itemCount: names.size, matched: 0, unmatched: 0, error: result.error };
  }

  let matched = 0;
  let unmatched = 0;
  for (const name of names) {
    const info = result.data.get(name);
    if (info) {
      matched += 1;
    } else {
      unmatched += 1;
    }
    upsertItemMetadata({
      item_name: name,
      collection: info?.collection ?? null,
      crate: info?.crate ?? null,
      rarity: info?.rarity ?? null,
      rarity_rank: info?.rarityRank ?? null,
    });
  }

  return { itemCount: names.size, matched, unmatched };
}
