import type { IPriceSnapshot } from "./types";

// 价格数据只在每小时同步（或手动触发的回填/刷新）时才变，两次写入之间同一个饰品被
// positions/watchlist 页面反复渲染多少次，getLatestPricesByPlatform/getPriceHistory
// 的结果都是一样的——缓存住能把这两条热路径查询从"每次页面渲染都查一次 SQLite"
// 变成"两次写入之间只查一次"。跟 lib/db/client.ts 的连接单例同理，用 globalThis 存，
// 防止 dev 模式热重载把缓存对象重建成好几份。
//
// 失效策略很简单：所有价格快照写入都走 lib/db/snapshots.ts 的 insertPriceSnapshot，
// 那里写完立刻调 invalidateItemPriceCache(item_name)，不会有"缓存和数据库不一致"的
// 窗口期——不需要 TTL，也不需要跨进程通知（采集器和网页服务是同一个 Node 进程）。
declare global {
  var __latestPricesCache: Map<string, IPriceSnapshot[]> | undefined;
  var __priceHistoryCache: Map<string, Map<string, IPriceSnapshot[]>> | undefined;
}

function latestPricesCache(): Map<string, IPriceSnapshot[]> {
  if (!global.__latestPricesCache) global.__latestPricesCache = new Map();
  return global.__latestPricesCache;
}

function priceHistoryCache(): Map<string, Map<string, IPriceSnapshot[]>> {
  if (!global.__priceHistoryCache) global.__priceHistoryCache = new Map();
  return global.__priceHistoryCache;
}

export function getCachedLatestPrices(itemName: string): IPriceSnapshot[] | undefined {
  return latestPricesCache().get(itemName);
}

export function setCachedLatestPrices(itemName: string, rows: IPriceSnapshot[]): void {
  latestPricesCache().set(itemName, rows);
}

export function getCachedPriceHistory(
  itemName: string,
  platform: string
): IPriceSnapshot[] | undefined {
  return priceHistoryCache().get(itemName)?.get(platform);
}

export function setCachedPriceHistory(
  itemName: string,
  platform: string,
  rows: IPriceSnapshot[]
): void {
  let byPlatform = priceHistoryCache().get(itemName);
  if (!byPlatform) {
    byPlatform = new Map();
    priceHistoryCache().set(itemName, byPlatform);
  }
  byPlatform.set(platform, rows);
}

export function invalidateItemPriceCache(itemName: string): void {
  latestPricesCache().delete(itemName);
  priceHistoryCache().delete(itemName);
}
