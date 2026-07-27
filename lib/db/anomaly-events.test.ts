import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import {
  addAnomalyEvent,
  countPendingAnomalyEvents,
  getAnomalyEvent,
  hasRecentAnomalyEvent,
  listAnomalyEvents,
  listPendingAnomalyEventsForItem,
  updateAnomalyEventStatus,
} from "./anomaly-events";

beforeEach(() => {
  testDb = createTestDb();
});

describe("anomaly-events", () => {
  it("addAnomalyEvent 首次写入返回 true", () => {
    const created = addAnomalyEvent({
      item_name: "AK-47 | Redline",
      platform: "C5",
      metric: "price_zscore",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: 6.5,
      price: 100,
    });

    expect(created).toBe(true);
    expect(listAnomalyEvents("pending")).toHaveLength(1);
  });

  it("同一 item+platform+metric+detected_at 重复写入被静默跳过，返回 false", () => {
    addAnomalyEvent({
      item_name: "AK-47 | Redline",
      platform: "C5",
      metric: "price_zscore",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: 6.5,
      price: 100,
    });

    const created = addAnomalyEvent({
      item_name: "AK-47 | Redline",
      platform: "C5",
      metric: "price_zscore",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: 999, // 同一时间点再来一次——不该覆盖
      price: 100,
    });

    expect(created).toBe(false);
    expect(listAnomalyEvents("pending")).toHaveLength(1);
    expect(listAnomalyEvents("pending")[0].value).toBe(6.5);
  });

  it("listAnomalyEvents 按 |value| 降序排列，不带 status 时返回全部", () => {
    addAnomalyEvent({
      item_name: "A",
      platform: "C5",
      metric: "price_zscore",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: -6,
      price: 10,
    });
    addAnomalyEvent({
      item_name: "B",
      platform: "C5",
      metric: "price_zscore",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: 20,
      price: 10,
    });

    expect(listAnomalyEvents().map((e) => e.item_name)).toEqual(["B", "A"]);
  });

  it("listAnomalyEvents(status) 只返回指定状态", () => {
    addAnomalyEvent({
      item_name: "A",
      platform: "C5",
      metric: "price_zscore",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: 6,
      price: 10,
    });
    const [event] = listAnomalyEvents("pending");
    updateAnomalyEventStatus(event.id, "dismissed");

    expect(listAnomalyEvents("pending")).toEqual([]);
    expect(listAnomalyEvents("dismissed")).toHaveLength(1);
  });

  it("updateAnomalyEventStatus 会写 review_note 和 reviewed_at", () => {
    addAnomalyEvent({
      item_name: "A",
      platform: "C5",
      metric: "manipulation_score",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: 70,
      price: 10,
    });
    const [event] = listAnomalyEvents("pending");

    updateAnomalyEventStatus(event.id, "external", "5-22 大更新");

    const updated = getAnomalyEvent(event.id);
    expect(updated?.status).toBe("external");
    expect(updated?.review_note).toBe("5-22 大更新");
    expect(updated?.reviewed_at).not.toBeNull();
  });

  it("hasRecentAnomalyEvent 判断同饰品同指标在时间窗口内是否已有记录", () => {
    addAnomalyEvent({
      item_name: "A",
      platform: "C5",
      metric: "manipulation_score",
      detected_at: "2026-07-10T00:00:00.000Z",
      value: 70,
      price: 10,
    });

    expect(hasRecentAnomalyEvent("A", "manipulation_score", "2026-07-05T00:00:00.000Z")).toBe(true);
    expect(hasRecentAnomalyEvent("A", "manipulation_score", "2026-07-15T00:00:00.000Z")).toBe(false);
    expect(hasRecentAnomalyEvent("A", "washout_signal", "2026-07-05T00:00:00.000Z")).toBe(false);
  });

  it("listPendingAnomalyEventsForItem 只返回该饰品 pending 的事件，按时间升序", () => {
    addAnomalyEvent({
      item_name: "A",
      platform: "C5",
      metric: "price_zscore",
      detected_at: "2026-07-02T00:00:00.000Z",
      value: 6,
      price: 10,
    });
    addAnomalyEvent({
      item_name: "A",
      platform: "C5",
      metric: "washout_signal",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: 20,
      price: 10,
    });
    addAnomalyEvent({
      item_name: "B",
      platform: "C5",
      metric: "price_zscore",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: 6,
      price: 10,
    });

    const rows = listPendingAnomalyEventsForItem("A");

    expect(rows.map((r) => r.metric)).toEqual(["washout_signal", "price_zscore"]);
  });

  it("countPendingAnomalyEvents 只统计 pending", () => {
    addAnomalyEvent({
      item_name: "A",
      platform: "C5",
      metric: "price_zscore",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: 6,
      price: 10,
    });
    addAnomalyEvent({
      item_name: "B",
      platform: "C5",
      metric: "price_zscore",
      detected_at: "2026-07-01T00:00:00.000Z",
      value: 6,
      price: 10,
    });
    const [, eventB] = listAnomalyEvents("pending").sort((a, b) => a.item_name.localeCompare(b.item_name));
    updateAnomalyEventStatus(eventB.id, "dismissed");

    expect(countPendingAnomalyEvents()).toBe(1);
  });
});
