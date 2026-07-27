import { describe, expect, it } from "vitest";
import { resampleHourly } from "./resample";
import type { IPriceSnapshot } from "../types";

function snapshot(capturedAt: string, price: number, volume: number | null = null): IPriceSnapshot {
  return {
    id: 0,
    item_name: "test-item",
    platform: "C5",
    price,
    volume,
    bidding_price: null,
    bidding_count: null,
    captured_at: capturedAt,
    created_at: capturedAt,
  };
}

describe("resampleHourly", () => {
  it("已经是一小时一条时原样透传", () => {
    const history = [
      snapshot("2026-07-26T00:00:00.000Z", 1),
      snapshot("2026-07-26T01:00:00.000Z", 2),
      snapshot("2026-07-26T02:00:00.000Z", 3),
    ];
    expect(resampleHourly(history).map((h) => h.price)).toEqual([1, 2, 3]);
  });

  it("同一小时内多条只保留时间最晚的一条", () => {
    const history = [
      snapshot("2026-07-26T00:05:00.000Z", 1),
      snapshot("2026-07-26T00:35:00.000Z", 2), // 同一小时桶，覆盖上一条
      snapshot("2026-07-26T01:10:00.000Z", 3),
    ];
    const result = resampleHourly(history);
    expect(result.map((h) => h.price)).toEqual([2, 3]);
  });

  it("跨多个小时桶时保持升序（依赖输入本身按时间升序，getPriceHistory 保证这一点）", () => {
    const history = [
      snapshot("2026-07-26T00:00:00.000Z", 1),
      snapshot("2026-07-26T00:20:00.000Z", 2),
      snapshot("2026-07-26T02:00:00.000Z", 3),
      snapshot("2026-07-26T03:00:00.000Z", 4),
    ];
    expect(resampleHourly(history).map((h) => h.price)).toEqual([2, 3, 4]);
  });

  it("空数组返回空数组", () => {
    expect(resampleHourly([])).toEqual([]);
  });
});
