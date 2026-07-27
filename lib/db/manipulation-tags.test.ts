import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import {
  addManipulationTag,
  deleteManipulationTag,
  listManipulationTags,
  listManipulationTagsForItem,
} from "./manipulation-tags";

beforeEach(() => {
  testDb = createTestDb();
});

describe("manipulation-tags", () => {
  it("添加后返回带 id 的完整记录", () => {
    const tag = addManipulationTag({
      item_name: "AK-47 | Redline",
      start_date: "2026-07-01",
      end_date: "2026-07-05",
      confidence: "high",
      note: "私董喊单",
    });

    expect(tag).toMatchObject({
      item_name: "AK-47 | Redline",
      start_date: "2026-07-01",
      end_date: "2026-07-05",
      confidence: "high",
      note: "私董喊单",
    });
    expect(tag.id).toEqual(expect.any(Number));
  });

  it("listManipulationTags 按 start_date 降序排列", () => {
    addManipulationTag({
      item_name: "A",
      start_date: "2026-07-01",
      end_date: null,
      confidence: "high",
      note: null,
    });
    addManipulationTag({
      item_name: "B",
      start_date: "2026-07-10",
      end_date: null,
      confidence: "medium",
      note: null,
    });

    const tags = listManipulationTags();

    expect(tags.map((t) => t.item_name)).toEqual(["B", "A"]);
  });

  it("listManipulationTagsForItem 只返回指定饰品的标记", () => {
    addManipulationTag({
      item_name: "A",
      start_date: "2026-07-01",
      end_date: null,
      confidence: "high",
      note: null,
    });
    addManipulationTag({
      item_name: "B",
      start_date: "2026-07-02",
      end_date: null,
      confidence: "high",
      note: null,
    });

    expect(listManipulationTagsForItem("A").map((t) => t.item_name)).toEqual(["A"]);
  });

  it("deleteManipulationTag 之后从列表里消失", () => {
    const tag = addManipulationTag({
      item_name: "A",
      start_date: "2026-07-01",
      end_date: null,
      confidence: "low",
      note: null,
    });

    deleteManipulationTag(tag.id);

    expect(listManipulationTags()).toEqual([]);
  });
});
