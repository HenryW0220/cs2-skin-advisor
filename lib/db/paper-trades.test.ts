import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./testing";

let testDb: Database.Database;
vi.mock("./client", async (importActual) => {
  const actual = await importActual<typeof import("./client")>();
  return { ...actual, getDb: () => testDb };
});

import {
  closePaperTrade,
  getLastClosedAt,
  hasOpenPaperTrade,
  listOpenPaperTrades,
  listPaperTrades,
  openPaperTrade,
} from "./paper-trades";

beforeEach(() => {
  testDb = createTestDb();
});

describe("db/paper-trades", () => {
  it("openPaperTrade 写入后能读出，buy_reasons 存成 JSON 字符串", () => {
    openPaperTrade({
      item_name: "AK-47 | Redline",
      platform: "C5",
      buy_price: 100,
      buy_score: 30,
      buy_reasons: ["RSI 超卖"],
      opened_at: "2026-07-01T00:00:00.000Z",
    });

    const [trade] = listPaperTrades();

    expect(trade.status).toBe("open");
    expect(JSON.parse(trade.buy_reasons)).toEqual(["RSI 超卖"]);
  });

  it("hasOpenPaperTrade 对没有仓位的饰品返回 false", () => {
    expect(hasOpenPaperTrade("AK-47 | Redline")).toBe(false);
  });

  it("hasOpenPaperTrade 对持仓中的饰品返回 true，平仓后变回 false", () => {
    openPaperTrade({
      item_name: "AK-47 | Redline",
      platform: "C5",
      buy_price: 100,
      buy_score: 30,
      buy_reasons: [],
      opened_at: "2026-07-01T00:00:00.000Z",
    });
    expect(hasOpenPaperTrade("AK-47 | Redline")).toBe(true);

    const [trade] = listOpenPaperTrades();
    closePaperTrade({
      id: trade.id,
      sell_price: 110,
      sell_net_price: 108.9,
      sell_score: -40,
      sell_reasons: ["卖出信号"],
      close_reason: "sell_signal",
      closed_at: "2026-07-10T00:00:00.000Z",
    });

    expect(hasOpenPaperTrade("AK-47 | Redline")).toBe(false);
  });

  it("listOpenPaperTrades 只返回 status=open 的行", () => {
    openPaperTrade({
      item_name: "A",
      platform: "C5",
      buy_price: 10,
      buy_score: 30,
      buy_reasons: [],
      opened_at: "2026-07-01T00:00:00.000Z",
    });
    openPaperTrade({
      item_name: "B",
      platform: "C5",
      buy_price: 10,
      buy_score: 30,
      buy_reasons: [],
      opened_at: "2026-07-02T00:00:00.000Z",
    });
    // 按 opened_at 降序排列，B 后开仓排在前面
    const [tradeB] = listOpenPaperTrades();
    closePaperTrade({
      id: tradeB.id,
      sell_price: 12,
      sell_net_price: 11.9,
      sell_score: -40,
      sell_reasons: [],
      close_reason: "timeout",
      closed_at: "2026-07-05T00:00:00.000Z",
    });

    expect(listOpenPaperTrades().map((t) => t.item_name)).toEqual(["A"]);
  });

  it("closePaperTrade 只能作用于 status=open 的行，对已平仓的行是 no-op", () => {
    openPaperTrade({
      item_name: "A",
      platform: "C5",
      buy_price: 10,
      buy_score: 30,
      buy_reasons: [],
      opened_at: "2026-07-01T00:00:00.000Z",
    });
    const [trade] = listOpenPaperTrades();
    closePaperTrade({
      id: trade.id,
      sell_price: 12,
      sell_net_price: 11.9,
      sell_score: -40,
      sell_reasons: [],
      close_reason: "timeout",
      closed_at: "2026-07-05T00:00:00.000Z",
    });

    // 对已经是 closed 的同一笔再平一次，价格不该变
    closePaperTrade({
      id: trade.id,
      sell_price: 999,
      sell_net_price: 999,
      sell_score: 0,
      sell_reasons: [],
      close_reason: "sell_signal",
      closed_at: "2026-07-06T00:00:00.000Z",
    });

    const [closed] = listPaperTrades();
    expect(closed.sell_price).toBe(12);
    expect(closed.close_reason).toBe("timeout");
  });

  it("getLastClosedAt 没平过仓返回 null，平过仓返回最近一次平仓时间", () => {
    expect(getLastClosedAt("A")).toBeNull();

    openPaperTrade({
      item_name: "A",
      platform: "C5",
      buy_price: 10,
      buy_score: 30,
      buy_reasons: [],
      opened_at: "2026-06-01T00:00:00.000Z",
    });
    let [trade] = listOpenPaperTrades();
    closePaperTrade({
      id: trade.id,
      sell_price: 12,
      sell_net_price: 11.9,
      sell_score: -40,
      sell_reasons: [],
      close_reason: "timeout",
      closed_at: "2026-06-10T00:00:00.000Z",
    });

    openPaperTrade({
      item_name: "A",
      platform: "C5",
      buy_price: 15,
      buy_score: 30,
      buy_reasons: [],
      opened_at: "2026-07-01T00:00:00.000Z",
    });
    [trade] = listOpenPaperTrades();
    closePaperTrade({
      id: trade.id,
      sell_price: 16,
      sell_net_price: 15.8,
      sell_score: -40,
      sell_reasons: [],
      close_reason: "timeout",
      closed_at: "2026-07-10T00:00:00.000Z",
    });

    expect(getLastClosedAt("A")).toBe("2026-07-10T00:00:00.000Z");
  });
});
