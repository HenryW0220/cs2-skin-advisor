import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import { listSignalSummaries, upsertSignalSummary } from "./signal-summaries";

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
