import { fetchItemCatalogEntries } from "./api/cs-item-db";
import { replaceItemCatalog } from "./db/item-catalog";

export interface IItemCatalogSyncSummary {
  total: number;
  skins: number;
  agents: number;
  error?: string;
}

// 全量刷新本地饰品目录（联想搜索用）。数据集是静态的，只在新箱子/新探员
// 发布后需要手动点一次；拉取失败时不动现有目录，旧数据继续可用。
export async function syncItemCatalog(): Promise<IItemCatalogSyncSummary> {
  const result = await fetchItemCatalogEntries();
  if (result.error || !result.data) {
    return { total: 0, skins: 0, agents: 0, error: result.error };
  }

  replaceItemCatalog(result.data);
  const skins = result.data.filter((e) => e.itemType === "skin").length;
  return { total: result.data.length, skins, agents: result.data.length - skins };
}
