import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import { getCachedReason, setCachedReason } from "./reason-cache";

beforeEach(() => {
  testDb = createTestDb();
});

describe("reason-cache", () => {
  it("没缓存过时返回 null", () => {
    expect(getCachedReason("key-1")).toBeNull();
  });

  it("写入后能读出", () => {
    setCachedReason("key-1", "AK-47 | Redline", "RSI 超卖，建议买入");

    expect(getCachedReason("key-1")).toBe("RSI 超卖，建议买入");
  });

  it("同一 cache_key 再次写入会覆盖旧理由", () => {
    setCachedReason("key-1", "AK-47 | Redline", "旧理由");
    setCachedReason("key-1", "AK-47 | Redline", "新理由");

    expect(getCachedReason("key-1")).toBe("新理由");
  });
});
