import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";
import type { IItemCatalogEntry } from "../api/cs-item-db";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import {
  countItemCatalog,
  getItemCatalogEntry,
  replaceItemCatalog,
  searchItemCatalog,
} from "./item-catalog";

beforeEach(() => {
  testDb = createTestDb();
});

const SAMPLE: IItemCatalogEntry[] = [
  { marketHashName: "AK-47 | Redline (Field-Tested)", nameCn: "AK-47 | 红线 (久经沙场)", iconUrl: "a.png", itemType: "skin" },
  { marketHashName: "M4A1-S | Hyper Beast (Factory New)", nameCn: "M4A1消音版 | 暴怒野兽 (崭新出厂)", iconUrl: "b.png", itemType: "skin" },
  { marketHashName: "AK-47 | Hyper Beast (Factory New)", nameCn: "AK-47 | 暴怒野兽 (崭新出厂)", iconUrl: "c.png", itemType: "skin" },
];

describe("item-catalog", () => {
  it("空表 countItemCatalog 是 0，getItemCatalogEntry 是 undefined", () => {
    expect(countItemCatalog()).toBe(0);
    expect(getItemCatalogEntry("AK-47 | Redline (Field-Tested)")).toBeUndefined();
  });

  it("replaceItemCatalog 写入后能按 market_hash_name 查到", () => {
    replaceItemCatalog(SAMPLE);

    expect(countItemCatalog()).toBe(3);
    expect(getItemCatalogEntry("AK-47 | Redline (Field-Tested)")).toMatchObject({
      name_cn: "AK-47 | 红线 (久经沙场)",
      icon_url: "a.png",
      item_type: "skin",
    });
  });

  it("replaceItemCatalog 是全量替换，第二次调用会清掉第一次没包含的条目", () => {
    replaceItemCatalog(SAMPLE);
    replaceItemCatalog([SAMPLE[0]]);

    expect(countItemCatalog()).toBe(1);
    expect(getItemCatalogEntry("M4A1-S | Hyper Beast (Factory New)")).toBeUndefined();
  });

  it("searchItemCatalog 空查询返回空数组", () => {
    replaceItemCatalog(SAMPLE);

    expect(searchItemCatalog("   ")).toEqual([]);
  });

  it("searchItemCatalog 中文子串匹配", () => {
    replaceItemCatalog(SAMPLE);

    const rows = searchItemCatalog("暴怒野兽");

    expect(rows.map((r) => r.market_hash_name).sort()).toEqual(
      ["AK-47 | Hyper Beast (Factory New)", "M4A1-S | Hyper Beast (Factory New)"].sort()
    );
  });

  it("searchItemCatalog 多个词按空格拆分，要求全部命中（AND）", () => {
    replaceItemCatalog(SAMPLE);

    const rows = searchItemCatalog("暴怒野兽 崭新");

    expect(rows.map((r) => r.market_hash_name).sort()).toEqual(
      ["AK-47 | Hyper Beast (Factory New)", "M4A1-S | Hyper Beast (Factory New)"].sort()
    );
    expect(searchItemCatalog("暴怒野兽 久经沙场")).toEqual([]);
  });

  it("searchItemCatalog 前缀命中的排在前面", () => {
    replaceItemCatalog(SAMPLE);

    const rows = searchItemCatalog("AK-47");

    expect(rows[0].market_hash_name.startsWith("AK-47")).toBe(true);
  });

  it("searchItemCatalog 查询里的 % 和 _ 按字面处理，不当通配符", () => {
    replaceItemCatalog(SAMPLE);

    expect(searchItemCatalog("100%不存在的名字_")).toEqual([]);
  });
});
