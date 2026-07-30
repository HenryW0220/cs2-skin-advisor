import type { IPriceSnapshot } from "./types";

// 价格数据只在每小时同步（或手动触发的回填/刷新）时才变，两次写入之间同一个饰品的
// getLatestPricesByPlatform 结果都是一样的——缓存住能把这条热路径查询从"每次调用都查
// 一次 SQLite"变成"两次写入之间只查一次"。跟 lib/db/client.ts 的连接单例同理，用
// globalThis 存，防止 dev 模式热重载把缓存对象重建成好几份。
//
// 失效策略很简单：所有价格快照写入都走 lib/db/snapshots.ts 的 insertPriceSnapshot，
// 那里写完立刻调 invalidateItemPriceCache(item_name)，不会有"缓存和数据库不一致"的
// 窗口期——不需要 TTL，也不需要跨进程通知（采集器和网页服务是同一个 Node 进程）。
//
// 只缓存"各平台最新一条"（每个饰品几行），不缓存价格历史：历史是每饰品几千行的大数组，
// 而真正遍历全部追踪饰品的都是批处理循环（异常扫描/模拟盘/信号预计算），缓存会把
// 本来"一次只留一个饰品"的流式循环变成"338 个饰品的完整历史同时驻留在堆里"——
// 2026-07-27 起云端每小时 OOM 崩溃就是这么来的，详见 getPriceHistory 的注释。
declare global {
  var __latestPricesCache: Map<string, IPriceSnapshot[]> | undefined;
}

function latestPricesCache(): Map<string, IPriceSnapshot[]> {
  if (!global.__latestPricesCache) global.__latestPricesCache = new Map();
  return global.__latestPricesCache;
}

export function getCachedLatestPrices(itemName: string): IPriceSnapshot[] | undefined {
  return latestPricesCache().get(itemName);
}

export function setCachedLatestPrices(itemName: string, rows: IPriceSnapshot[]): void {
  latestPricesCache().set(itemName, rows);
}

export function invalidateItemPriceCache(itemName: string): void {
  latestPricesCache().delete(itemName);
}

// 单测用：清空缓存。这个 Map 是模块级全局，lib/db/*.test.ts 每个用例都建一个
// 全新的 :memory: 数据库，但缓存不会跟着重建，上一个用例缓存的数据会泄漏进下一个——
// 在 beforeEach 里调这个函数隔离。
export function resetPriceCacheForTesting(): void {
  latestPricesCache().clear();
}
