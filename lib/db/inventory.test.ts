import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import {
  addInventoryItem,
  deleteInventoryItem,
  findInventoryItemBySteamAssetId,
  findInventoryItemsByName,
  getInventoryItem,
  listInventory,
  listSteamLinkedInventory,
  updateInventoryItem,
} from "./inventory";

beforeEach(() => {
  testDb = createTestDb();
});

describe("inventory", () => {
  it("添加后返回带 id 的完整记录，未传字段用默认值", () => {
    const item = addInventoryItem({
      item_name: "AK-47 | Redline",
      platform: "steam",
      buy_price: 100,
      quantity: 1,
      buy_date: "2026-07-01",
      notes: null,
    });

    expect(item.id).toEqual(expect.any(Number));
    expect(item).toMatchObject({
      item_name: "AK-47 | Redline",
      buy_price: 100,
      name_cn: null,
      icon_url: null,
      steam_asset_id: null,
    });
  });

  it("getInventoryItem 查不到时返回 undefined", () => {
    expect(getInventoryItem(999)).toBeUndefined();
  });

  it("deleteInventoryItem 之后从列表消失", () => {
    const item = addInventoryItem({
      item_name: "AK-47 | Redline",
      platform: "steam",
      buy_price: 100,
      quantity: 1,
      buy_date: "2026-07-01",
      notes: null,
    });

    deleteInventoryItem(item.id);

    expect(listInventory()).toEqual([]);
  });

  it("updateInventoryItem 只更新传入的字段，其余保持不变", () => {
    const item = addInventoryItem({
      item_name: "AK-47 | Redline",
      platform: "steam",
      buy_price: 100,
      quantity: 1,
      buy_date: "2026-07-01",
      notes: "备注",
    });

    const updated = updateInventoryItem(item.id, { buy_price: 150 });

    expect(updated).toMatchObject({
      buy_price: 150,
      quantity: 1,
      buy_date: "2026-07-01",
      notes: "备注",
    });
  });

  it("updateInventoryItem 对不存在的 id 返回 undefined", () => {
    expect(updateInventoryItem(999, { buy_price: 1 })).toBeUndefined();
  });

  it("findInventoryItemsByName 支持同名多条记录", () => {
    addInventoryItem({
      item_name: "AK-47 | Redline",
      platform: "steam",
      buy_price: 100,
      quantity: 1,
      buy_date: "2026-07-01",
      notes: null,
    });
    addInventoryItem({
      item_name: "AK-47 | Redline",
      platform: "c5",
      buy_price: 110,
      quantity: 1,
      buy_date: "2026-07-02",
      notes: null,
    });

    expect(findInventoryItemsByName("AK-47 | Redline")).toHaveLength(2);
  });

  it("findInventoryItemBySteamAssetId 按 asset id 精确查找", () => {
    addInventoryItem({
      item_name: "AK-47 | Redline",
      platform: "steam",
      buy_price: 100,
      quantity: 1,
      buy_date: "2026-07-01",
      notes: null,
      steam_asset_id: "asset-123",
    });

    expect(findInventoryItemBySteamAssetId("asset-123")).toMatchObject({ item_name: "AK-47 | Redline" });
    expect(findInventoryItemBySteamAssetId("asset-999")).toBeUndefined();
  });

  it("listSteamLinkedInventory 只返回 steam_asset_id 非空的行", () => {
    addInventoryItem({
      item_name: "手动添加的",
      platform: "steam",
      buy_price: 100,
      quantity: 1,
      buy_date: "2026-07-01",
      notes: null,
    });
    addInventoryItem({
      item_name: "Steam 导入的",
      platform: "steam",
      buy_price: 100,
      quantity: 1,
      buy_date: "2026-07-01",
      notes: null,
      steam_asset_id: "asset-1",
    });

    expect(listSteamLinkedInventory().map((i) => i.item_name)).toEqual(["Steam 导入的"]);
  });
});
