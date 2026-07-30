import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";
import { resetPriceCacheForTesting } from "../signal-cache";

// lib/db/* 直接打真实 SQL，不能靠 mock 验证查询语义本身对不对（比如 JOIN 条件、
// UNIQUE 冲突时的静默跳过、平台排除名单）——用 createTestDb() 建一个跑过真实
// db/migrations/*.sql 的内存库，每个用例独立一份，测的是查询语义，不是"函数被调用过"。
// createTestDb（lib/db/testing.ts）内部也从 "./client" 导入 createConnection 建库，
// mock 整个模块时必须用 importActual 保留真实的 createConnection，只替换 getDb——
// 不然 testDb 自己都建不出来。
let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import {
  SIGNAL_HISTORY_WINDOW_DAYS,
  getLatestPricesByPlatform,
  getLatestSnapshotTime,
  getPriceHistory,
  getRecentPriceHistory,
  insertPriceSnapshot,
} from "./snapshots";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  testDb = createTestDb();
  resetPriceCacheForTesting();
});

describe("insertPriceSnapshot / getPriceHistory", () => {
  it("写入后能按时间升序读出", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: "2026-07-01T02:00:00.000Z",
    });
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 101,
      volume: 6,
      captured_at: "2026-07-01T01:00:00.000Z",
    });

    const history = getPriceHistory("AK-47 | Redline", "C5");

    expect(history.map((h) => h.price)).toEqual([101, 100]);
  });

  it("同一 item_name+platform+captured_at 重复写入被静默忽略", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: "2026-07-01T02:00:00.000Z",
    });
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 999, // 同一时间点的不同价格——不该覆盖，应该被 INSERT OR IGNORE 跳过
      volume: 5,
      captured_at: "2026-07-01T02:00:00.000Z",
    });

    const history = getPriceHistory("AK-47 | Redline", "C5");

    expect(history).toHaveLength(1);
    expect(history[0].price).toBe(100);
  });

  it("不传 bidding_price/bidding_count 时存 null", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: "2026-07-01T02:00:00.000Z",
    });

    const [snapshot] = getPriceHistory("AK-47 | Redline", "C5");

    expect(snapshot.bidding_price).toBeNull();
    expect(snapshot.bidding_count).toBeNull();
  });

  it("传了 bidding_price/bidding_count 时按原值存", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "BUFF",
      price: 100,
      volume: 5,
      bidding_price: 95,
      bidding_count: 3,
      captured_at: "2026-07-01T02:00:00.000Z",
    });

    const [snapshot] = getPriceHistory("AK-47 | Redline", "BUFF");

    expect(snapshot.bidding_price).toBe(95);
    expect(snapshot.bidding_count).toBe(3);
  });

  it("sinceIso 只返回该时间点及之后的快照", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: "2026-07-01T00:00:00.000Z",
    });
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 110,
      volume: 5,
      captured_at: "2026-07-02T00:00:00.000Z",
    });

    const history = getPriceHistory("AK-47 | Redline", "C5", "2026-07-01T12:00:00.000Z");

    expect(history.map((h) => h.price)).toEqual([110]);
  });

  it("不存在的饰品返回空数组", () => {
    expect(getPriceHistory("不存在的饰品", "C5")).toEqual([]);
  });
});

describe("getRecentPriceHistory", () => {
  it("默认窗口足够长，能覆盖信号函数最长的回溯需求（嫌疑分要 169 个小时桶）", () => {
    expect(SIGNAL_HISTORY_WINDOW_DAYS * 24).toBeGreaterThanOrEqual(169);
  });

  it("截掉窗口之外的旧快照，只返回窗口内的", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: isoDaysAgo(SIGNAL_HISTORY_WINDOW_DAYS + 5),
    });
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 110,
      volume: 5,
      captured_at: isoDaysAgo(1),
    });

    const history = getRecentPriceHistory("AK-47 | Redline", "C5");

    expect(history.map((h) => h.price)).toEqual([110]);
  });

  it("窗口内的快照按时间升序返回（信号函数都从数组末尾往回取，顺序不能乱）", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: isoDaysAgo(1),
    });
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 90,
      volume: 5,
      captured_at: isoDaysAgo(3),
    });

    const history = getRecentPriceHistory("AK-47 | Redline", "C5");

    expect(history.map((h) => h.price)).toEqual([90, 100]);
  });

  it("可以传 days 覆盖默认窗口", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: isoDaysAgo(5),
    });

    expect(getRecentPriceHistory("AK-47 | Redline", "C5", 2)).toEqual([]);
    expect(getRecentPriceHistory("AK-47 | Redline", "C5", 10)).toHaveLength(1);
  });

  it("只按 item_name+platform 过滤，不串到别的平台", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: isoDaysAgo(1),
    });
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "BUFF",
      price: 105,
      volume: 5,
      captured_at: isoDaysAgo(1),
    });

    const history = getRecentPriceHistory("AK-47 | Redline", "C5");

    expect(history.map((h) => h.platform)).toEqual(["C5"]);
  });
});

describe("getLatestSnapshotTime", () => {
  it("表为空时返回 null", () => {
    expect(getLatestSnapshotTime()).toBeNull();
  });

  it("有数据时返回非空时间字符串", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: "2026-07-01T00:00:00.000Z",
    });

    expect(getLatestSnapshotTime()).toEqual(expect.any(String));
  });
});

describe("getLatestPricesByPlatform", () => {
  it("每个平台只返回 captured_at 最新的一条", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: "2026-07-01T00:00:00.000Z",
    });
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 110,
      volume: 5,
      captured_at: "2026-07-02T00:00:00.000Z",
    });

    const rows = getLatestPricesByPlatform("AK-47 | Redline");

    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(110);
  });

  it("不同平台各返回一条", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: "2026-07-01T00:00:00.000Z",
    });
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "BUFF",
      price: 105,
      volume: 5,
      captured_at: "2026-07-01T00:00:00.000Z",
    });

    const platforms = getLatestPricesByPlatform("AK-47 | Redline")
      .map((r) => r.platform)
      .sort();

    expect(platforms).toEqual(["BUFF", "C5"]);
  });

  it("STEAM/HALOSKINS 即使有数据也被排除", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: "2026-07-01T00:00:00.000Z",
    });
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "STEAM",
      price: 999,
      volume: 5,
      captured_at: "2026-07-01T00:00:00.000Z",
    });
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "HALOSKINS",
      price: 888,
      volume: 5,
      captured_at: "2026-07-01T00:00:00.000Z",
    });

    const platforms = getLatestPricesByPlatform("AK-47 | Redline").map((r) => r.platform);

    expect(platforms).toEqual(["C5"]);
  });

  it("只有 STEAM/HALOSKINS 有数据时返回空数组", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "STEAM",
      price: 999,
      volume: 5,
      captured_at: "2026-07-01T00:00:00.000Z",
    });

    expect(getLatestPricesByPlatform("AK-47 | Redline")).toEqual([]);
  });

  it("插入新快照会让缓存失效", () => {
    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 100,
      volume: 5,
      captured_at: "2026-07-01T00:00:00.000Z",
    });
    expect(getLatestPricesByPlatform("AK-47 | Redline")[0].price).toBe(100); // 触发缓存写入

    insertPriceSnapshot({
      item_name: "AK-47 | Redline",
      platform: "C5",
      price: 120,
      volume: 5,
      captured_at: "2026-07-02T00:00:00.000Z",
    });

    expect(getLatestPricesByPlatform("AK-47 | Redline")[0].price).toBe(120);
  });

  it("不存在的饰品返回空数组", () => {
    expect(getLatestPricesByPlatform("不存在的饰品")).toEqual([]);
  });
});
