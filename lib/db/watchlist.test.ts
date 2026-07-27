import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import { addWatchlistItem, listWatchlist, removeWatchlistItem } from "./watchlist";

beforeEach(() => {
  testDb = createTestDb();
});

describe("watchlist", () => {
  it("空表返回空数组", () => {
    expect(listWatchlist()).toEqual([]);
  });

  it("添加后返回带 id 的完整记录，name_cn/icon_url 不传时是 null", () => {
    const item = addWatchlistItem({
      item_name: "AK-47 | Redline",
      target_buy_price: 100,
      target_sell_price: 150,
      notes: "等回调",
    });

    expect(item).toMatchObject({
      item_name: "AK-47 | Redline",
      target_buy_price: 100,
      target_sell_price: 150,
      notes: "等回调",
      name_cn: null,
      icon_url: null,
    });
    expect(item.id).toEqual(expect.any(Number));
  });

  it("传了 name_cn/icon_url 时按原值存", () => {
    const item = addWatchlistItem({
      item_name: "AK-47 | Redline",
      name_cn: "AK-47 | 红线",
      icon_url: "icon.png",
      target_buy_price: null,
      target_sell_price: null,
      notes: null,
    });

    expect(item.name_cn).toBe("AK-47 | 红线");
    expect(item.icon_url).toBe("icon.png");
  });

  it("removeWatchlistItem 之后从列表里消失", () => {
    const item = addWatchlistItem({
      item_name: "AK-47 | Redline",
      target_buy_price: null,
      target_sell_price: null,
      notes: null,
    });

    removeWatchlistItem(item.id);

    expect(listWatchlist()).toEqual([]);
  });
});
