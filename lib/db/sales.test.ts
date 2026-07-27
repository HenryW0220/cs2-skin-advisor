import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import { addSaleRecord, listSaleRecords, updateSaleSellPrice } from "./sales";

beforeEach(() => {
  testDb = createTestDb();
});

describe("sales", () => {
  it("空表返回空数组", () => {
    expect(listSaleRecords()).toEqual([]);
  });

  it("写入后能读出，sell_price 待补时是 null", () => {
    addSaleRecord({
      item_name: "AK-47 | Redline",
      name_cn: "AK-47 | 红线",
      icon_url: null,
      quantity: 1,
      buy_price: 100,
      sell_price: null,
      sell_source: null,
      steam_asset_id: "asset-1",
    });

    const rows = listSaleRecords();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      item_name: "AK-47 | Redline",
      buy_price: 100,
      sell_price: null,
    });
  });

  it("updateSaleSellPrice 补价后 sell_price/gross/platform 都写入，sell_source 固定为 manual", () => {
    addSaleRecord({
      item_name: "AK-47 | Redline",
      name_cn: null,
      icon_url: null,
      quantity: 1,
      buy_price: 100,
      sell_price: null,
      sell_source: null,
      steam_asset_id: null,
    });
    const [record] = listSaleRecords();

    const updated = updateSaleSellPrice(record.id, 148.5, 150, "c5");

    expect(updated).toMatchObject({
      sell_price: 148.5,
      sell_price_gross: 150,
      sell_platform: "c5",
      sell_source: "manual",
    });
  });

  it("listSaleRecords 按 sold_at 降序排列", () => {
    addSaleRecord({
      item_name: "先卖的",
      name_cn: null,
      icon_url: null,
      quantity: 1,
      buy_price: 10,
      sell_price: null,
      sell_source: null,
      steam_asset_id: null,
    });
    testDb.prepare("UPDATE sales_records SET sold_at = '2026-01-01' WHERE item_name = '先卖的'").run();
    addSaleRecord({
      item_name: "后卖的",
      name_cn: null,
      icon_url: null,
      quantity: 1,
      buy_price: 10,
      sell_price: null,
      sell_source: null,
      steam_asset_id: null,
    });
    testDb.prepare("UPDATE sales_records SET sold_at = '2026-07-01' WHERE item_name = '后卖的'").run();

    expect(listSaleRecords().map((r) => r.item_name)).toEqual(["后卖的", "先卖的"]);
  });
});
