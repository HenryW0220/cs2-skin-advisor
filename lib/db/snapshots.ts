import { getDb } from "./client";
import type { IPriceSnapshot } from "../types";

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

// 全表最新一条快照的时间，给定时同步判断"距离上次同步过了多久"用；一条都没有时返回 null。
export function getLatestSnapshotTime(): string | null {
  const row = getDb()
    .prepare("SELECT MAX(created_at) AS latest FROM price_snapshots")
    .get() as { latest: string | null };
  return row.latest;
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
