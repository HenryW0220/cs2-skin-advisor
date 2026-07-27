import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import { listCandidatePoolItems, upsertCandidatePoolItem } from "./market-candidate-pool";

beforeEach(() => {
  testDb = createTestDb();
});

describe("market-candidate-pool", () => {
  it("空表返回空数组", () => {
    expect(listCandidatePoolItems()).toEqual([]);
  });

  it("写入后能读出，rarity 为 null 也能存", () => {
    upsertCandidatePoolItem({ item_name: "AK-47 | Redline", rarity: "Classified" });
    upsertCandidatePoolItem({ item_name: "P250 | Sand Dune", rarity: null });

    const rows = listCandidatePoolItems();

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.item_name === "P250 | Sand Dune")?.rarity).toBeNull();
  });

  it("同一 item_name 重复 upsert 不会新增第二行，也不覆盖已有 rarity（DO NOTHING）", () => {
    upsertCandidatePoolItem({ item_name: "AK-47 | Redline", rarity: "Classified" });
    upsertCandidatePoolItem({ item_name: "AK-47 | Redline", rarity: "换了个值也不该生效" });

    const rows = listCandidatePoolItems();

    expect(rows).toHaveLength(1);
    expect(rows[0].rarity).toBe("Classified");
  });
});
