import { getDb } from "./client";
import type { IAnomalyEvent, IAnomalyMetric, IAnomalyStatus } from "../types";

// 同一饰品+平台+指标+时间点只留一条（见迁移文件的 UNIQUE 约束），重复扫描到的
// 异常静默跳过——返回是否真的新建了一条，调用方靠这个统计"这轮扫描新发现几个"。
export function addAnomalyEvent(event: {
  item_name: string;
  platform: string;
  metric: IAnomalyMetric;
  detected_at: string;
  value: number;
  price: number;
}): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO anomaly_events (item_name, platform, metric, detected_at, value, price)
       VALUES (@item_name, @platform, @metric, @detected_at, @value, @price)`
    )
    .run(event);
  return result.changes > 0;
}

// 按异常程度（|value| 从大到小）排序，不是按时间——待审核的量级不小，
// 让最可疑的候选排在最前面，用户优先审核这些，而不是从头到尾按时间线过一遍。
export function listAnomalyEvents(status?: IAnomalyStatus): IAnomalyEvent[] {
  const db = getDb();
  if (status) {
    return db
      .prepare("SELECT * FROM anomaly_events WHERE status = ? ORDER BY ABS(value) DESC")
      .all(status) as IAnomalyEvent[];
  }
  return db
    .prepare("SELECT * FROM anomaly_events ORDER BY ABS(value) DESC")
    .all() as IAnomalyEvent[];
}

export function getAnomalyEvent(id: number): IAnomalyEvent | undefined {
  return getDb().prepare("SELECT * FROM anomaly_events WHERE id = ?").get(id) as
    | IAnomalyEvent
    | undefined;
}

export function updateAnomalyEventStatus(
  id: number,
  status: IAnomalyStatus,
  reviewNote?: string | null
): void {
  getDb()
    .prepare(
      "UPDATE anomaly_events SET status = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ?"
    )
    .run(status, reviewNote ?? null, id);
}

// 同一波行情（版本更新、一轮操盘）会在同一个饰品上打出好几条异常事件，
// 审核时支持"这个饰品的待审核事件一并处理"，不用一条条点。
export function listPendingAnomalyEventsForItem(itemName: string): IAnomalyEvent[] {
  return getDb()
    .prepare(
      "SELECT * FROM anomaly_events WHERE item_name = ? AND status = 'pending' ORDER BY detected_at ASC"
    )
    .all(itemName) as IAnomalyEvent[];
}

export function countPendingAnomalyEvents(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) c FROM anomaly_events WHERE status = 'pending'")
    .get() as { c: number };
  return row.c;
}
