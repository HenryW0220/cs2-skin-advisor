import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import {
  getItemMetadata,
  listItemMetadata,
  listItemMetadataByCollection,
  upsertItemMetadata,
} from "./item-metadata";

beforeEach(() => {
  testDb = createTestDb();
});

describe("item-metadata", () => {
  it("没有记录时 getItemMetadata 返回 undefined", () => {
    expect(getItemMetadata("AK-47 | Redline")).toBeUndefined();
  });

  it("写入后能读出", () => {
    upsertItemMetadata({
      item_name: "AK-47 | Redline",
      collection: "The Dust 2 Collection",
      crate: null,
      rarity: "Classified",
      rarity_rank: 4,
    });

    expect(getItemMetadata("AK-47 | Redline")).toMatchObject({
      item_name: "AK-47 | Redline",
      collection: "The Dust 2 Collection",
      rarity: "Classified",
      rarity_rank: 4,
    });
  });

  it("同一 item_name 重复 upsert 会覆盖旧值", () => {
    upsertItemMetadata({
      item_name: "AK-47 | Redline",
      collection: "旧收藏品",
      crate: null,
      rarity: "Classified",
      rarity_rank: 4,
    });
    upsertItemMetadata({
      item_name: "AK-47 | Redline",
      collection: "新收藏品",
      crate: null,
      rarity: "Covert",
      rarity_rank: 5,
    });

    expect(getItemMetadata("AK-47 | Redline")).toMatchObject({
      collection: "新收藏品",
      rarity: "Covert",
      rarity_rank: 5,
    });
    expect(listItemMetadata()).toHaveLength(1);
  });

  it("listItemMetadataByCollection 只返回同收藏品的，按 rarity_rank 降序（上级在前）", () => {
    upsertItemMetadata({
      item_name: "下级炼金料",
      collection: "手套收藏品",
      crate: null,
      rarity: "Classified",
      rarity_rank: 4,
    });
    upsertItemMetadata({
      item_name: "上级",
      collection: "手套收藏品",
      crate: null,
      rarity: "Covert",
      rarity_rank: 5,
    });
    upsertItemMetadata({
      item_name: "其他收藏品的品",
      collection: "别的收藏品",
      crate: null,
      rarity: "Covert",
      rarity_rank: 5,
    });

    const rows = listItemMetadataByCollection("手套收藏品");

    expect(rows.map((r) => r.item_name)).toEqual(["上级", "下级炼金料"]);
  });
});
