import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import {
  addPushSubscription,
  listPushSubscriptions,
  removePushSubscription,
} from "./push-subscriptions";

beforeEach(() => {
  testDb = createTestDb();
});

describe("push-subscriptions", () => {
  it("空表返回空数组", () => {
    expect(listPushSubscriptions()).toEqual([]);
  });

  it("写入后能读出", () => {
    addPushSubscription({ endpoint: "https://push.example/a", p256dh: "key1", auth: "auth1" });

    const rows = listPushSubscriptions();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: "https://push.example/a", p256dh: "key1", auth: "auth1" });
  });

  it("同一 endpoint 重复订阅会更新 p256dh/auth，不会变成两条", () => {
    addPushSubscription({ endpoint: "https://push.example/a", p256dh: "old", auth: "old" });
    addPushSubscription({ endpoint: "https://push.example/a", p256dh: "new", auth: "new" });

    const rows = listPushSubscriptions();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ p256dh: "new", auth: "new" });
  });

  it("删除后不再出现在列表里", () => {
    addPushSubscription({ endpoint: "https://push.example/a", p256dh: "key1", auth: "auth1" });

    removePushSubscription("https://push.example/a");

    expect(listPushSubscriptions()).toEqual([]);
  });
});
