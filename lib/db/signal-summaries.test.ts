import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import {
  getLastFullSyncTime,
  listSignalSummaries,
  upsertSignalSummary,
} from "./signal-summaries";

beforeEach(() => {
  testDb = createTestDb();
});

describe("signal-summaries", () => {
  it("空表返回空 Map", () => {
    expect(listSignalSummaries().size).toBe(0);
  });

  it("写入后能按 item_name 读出，recent_prices 存成 JSON 字符串", () => {
    upsertSignalSummary({
      item_name: "AK-47 | Redline",
      platform: "C5",
      market_price: 100,
      action: "HOLD",
      score: 10,
      change_today_percent: 1.5,
      recent_prices: [98, 99, 100],
    });

    const map = listSignalSummaries();
    const summary = map.get("AK-47 | Redline");

    expect(summary).toBeDefined();
    expect(summary?.market_price).toBe(100);
    expect(JSON.parse(summary!.recent_prices)).toEqual([98, 99, 100]);
  });

  it("同一 item_name 重复 upsert 会整行覆盖，不会出现两条", () => {
    upsertSignalSummary({
      item_name: "AK-47 | Redline",
      platform: "C5",
      market_price: 100,
      action: "HOLD",
      score: 10,
      change_today_percent: null,
      recent_prices: [100],
    });
    upsertSignalSummary({
      item_name: "AK-47 | Redline",
      platform: "BUFF",
      market_price: 120,
      action: "SELL",
      score: -50,
      change_today_percent: 5,
      recent_prices: [110, 120],
    });

    const map = listSignalSummaries();

    expect(map.size).toBe(1);
    expect(map.get("AK-47 | Redline")).toMatchObject({
      platform: "BUFF",
      market_price: 120,
      action: "SELL",
      score: -50,
    });
  });
});

describe("getLastFullSyncTime", () => {
  it("没跑过完整同步时返回 null", () => {
    expect(getLastFullSyncTime()).toBeNull();
  });

  // 这是调度器判断"启动要不要补跑完整同步"的唯一依据，语义必须是"完整同步跑完的时间"。
  // 之前用的是 price_snapshots 的最新写入时间，被每 10 分钟一次的 C5 高频 tick 顶得永远
  // 是新的，导致补跑永远不触发、每次部署后完整同步停摆最多一小时。
  it("有记录时返回最新的 computed_at", () => {
    upsertSignalSummary({
      item_name: "AK-47 | Redline",
      platform: "C5",
      market_price: 100,
      action: "HOLD",
      score: 10,
      change_today_percent: null,
      recent_prices: [100],
    });
    expect(getLastFullSyncTime()).toEqual(expect.any(String));
  });
});
