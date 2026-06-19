import { getDb } from "./client";
import type { IPriceSnapshot } from "../types";

// 同一 item_name + platform + captured_at 重复写入会被 INSERT OR IGNORE 静默跳过，
// 方便定时任务重复拉取同一时间点的数据时不报错。
export function insertPriceSnapshot(
  snapshot: Pick<
    IPriceSnapshot,
    "item_name" | "platform" | "price" | "volume" | "captured_at"
  >
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO price_snapshots (item_name, platform, price, volume, captured_at)
       VALUES (@item_name, @platform, @price, @volume, @captured_at)`
    )
    .run(snapshot);
}

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
  return db
    .prepare(
      `SELECT * FROM price_snapshots
       WHERE item_name = ? AND platform = ?
       ORDER BY captured_at ASC`
    )
    .all(itemName, platform) as IPriceSnapshot[];
}

// 同一个饰品在各平台最新的一条价格快照，每个 platform 只取 captured_at 最大的那条，
// 用于跨平台价差计算。
export function getLatestPricesByPlatform(itemName: string): IPriceSnapshot[] {
  return getDb()
    .prepare(
      `SELECT ps.* FROM price_snapshots ps
       JOIN (
         SELECT platform, MAX(captured_at) AS max_captured_at
         FROM price_snapshots
         WHERE item_name = ?
         GROUP BY platform
       ) latest
         ON ps.platform = latest.platform
        AND ps.captured_at = latest.max_captured_at
       WHERE ps.item_name = ?`
    )
    .all(itemName, itemName) as IPriceSnapshot[];
}
