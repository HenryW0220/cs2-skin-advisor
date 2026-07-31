import { getDb } from "./client";
import {
  getCachedLatestPrices,
  invalidateItemPriceCache,
  setCachedLatestPrices,
} from "../signal-cache";
import type { IPriceSnapshot } from "../types";

// 不追踪这两个平台：都不是国内玩家实际交易的地方（HALOSKINS 是海外小众平台；STEAM
// 社区市场余额提现有折损、标价虚高，早就在 pickReferencePlatform 里垫底，2026-07-27
// 起直接不收集）。lib/sync.ts 写入 SteamDT 批量数据前按这个名单过滤，这里同时把这两个
// 平台从查询结果里排除，之前已经写进 price_snapshots 的历史行不再被任何页面/信号读到
// （不删历史行，只是不再展示——真要清空间再单独处理）。
export const EXCLUDED_PLATFORMS = ["STEAM", "HALOSKINS"] as const;
const EXCLUDED_PLATFORMS_PLACEHOLDERS = EXCLUDED_PLATFORMS.map(() => "?").join(",");

// 同一 item_name + platform + captured_at 重复写入会被 INSERT OR IGNORE 静默跳过，
// 方便定时任务重复拉取同一时间点的数据时不报错。
// bidding_price/bidding_count 是求购侧挂单深度，C5 直连价格数据没有这两项，调用方不传时存 null。
export function insertPriceSnapshot(
  snapshot: Pick<
    IPriceSnapshot,
    "item_name" | "platform" | "price" | "volume" | "captured_at"
  > &
    Partial<Pick<IPriceSnapshot, "bidding_price" | "bidding_count">>
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO price_snapshots
         (item_name, platform, price, volume, bidding_price, bidding_count, captured_at)
       VALUES (@item_name, @platform, @price, @volume, @bidding_price, @bidding_count, @captured_at)`
    )
    .run({
      bidding_price: null,
      bidding_count: null,
      ...snapshot,
    });
  invalidateItemPriceCache(snapshot.item_name);
}

// 信号计算最多往回看多少天。所有信号函数的回溯需求里最长的是嫌疑分的
// `hourlyPrices.slice(-169, -1)`（169 个小时桶），价格 z-score 和成交量异动都是 168 期，
// 洗盘 48 期、追涨 24 期、MA30/RSI14 更短，走势图用的 recentPrices 是近 7 天——
// 折算成时间是 7.05 天，取 21 天留 3 倍余量，同步中断留下数据空洞时也够填满窗口。
//
// 之所以必须有这个上限而不是每次读全量：C5 高频 tick（10 分钟一次）让单个饰品每天多
// 144 行快照，历史长度会无上限地涨，而异常扫描/模拟盘/信号预计算都是"遍历全部追踪
// 饰品"的循环，读全量等于每小时把整张表搬进内存一遍。
export const SIGNAL_HISTORY_WINDOW_DAYS = 21;

export function getPriceHistory(
  itemName: string,
  platform: IPriceSnapshot["platform"],
  sinceIso?: string
): IPriceSnapshot[] {
  const db = getDb();
  if (sinceIso) {
    return db
      .prepare(
        `SELECT * FROM price_snapshots
         WHERE item_name = ? AND platform = ? AND captured_at >= ?
         ORDER BY captured_at ASC`
      )
      .all(itemName, platform, sinceIso) as IPriceSnapshot[];
  }
  // 全量历史只给"确实需要看完整 90 天"的两个地方用：饰品详情页图表的"全部"区间、
  // 一次性回溯扫描（scanHistoricalPriceAnomalies）。这里刻意不缓存——单个饰品几千行，
  // 缓存住会让遍历全部追踪饰品的批处理循环把所有历史同时留在堆里（338 个饰品 × 约
  // 3300 行 ≈ 440MB，正好撑爆云端 1GB 机器的 Node 堆，2026-07-27 起每小时 OOM 崩溃
  // 一次就是这么来的）。信号计算走 getRecentPriceHistory，不要用这个。
  return db
    .prepare(
      `SELECT * FROM price_snapshots
       WHERE item_name = ? AND platform = ?
       ORDER BY captured_at ASC`
    )
    .all(itemName, platform) as IPriceSnapshot[];
}

/**
 * 信号计算专用的价格历史：只取最近 SIGNAL_HISTORY_WINDOW_DAYS 天，按 captured_at 升序。
 *
 * 信号函数都是从数组末尾往回取固定期数（见 SIGNAL_HISTORY_WINDOW_DAYS 的推导），
 * 截掉更早的数据不影响任何指标结果。
 *
 * @param days 覆盖默认窗口，单位是天；只在测试或一次性脚本里需要传
 */
export function getRecentPriceHistory(
  itemName: string,
  platform: IPriceSnapshot["platform"],
  days: number = SIGNAL_HISTORY_WINDOW_DAYS
): IPriceSnapshot[] {
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return getPriceHistory(itemName, platform, sinceIso);
}

// 同一个饰品在各平台最新的一条价格快照，每个 platform 只取 captured_at 最大的那条，
// 用于跨平台价差计算。
export function getLatestPricesByPlatform(itemName: string): IPriceSnapshot[] {
  const cached = getCachedLatestPrices(itemName);
  if (cached) return cached;
  const rows = getDb()
    .prepare(
      `SELECT ps.* FROM price_snapshots ps
       JOIN (
         SELECT platform, MAX(captured_at) AS max_captured_at
         FROM price_snapshots
         WHERE item_name = ? AND platform NOT IN (${EXCLUDED_PLATFORMS_PLACEHOLDERS})
         GROUP BY platform
       ) latest
         ON ps.platform = latest.platform
        AND ps.captured_at = latest.max_captured_at
       WHERE ps.item_name = ?`
    )
    .all(itemName, ...EXCLUDED_PLATFORMS, itemName) as IPriceSnapshot[];
  setCachedLatestPrices(itemName, rows);
  return rows;
}
