import { describe, expect, it } from "vitest";
import { computeMomentumChaseSignal } from "./momentum-chase";

function flatSeries(length: number, price: number): number[] {
  return Array.from({ length }, () => price);
}

describe("computeMomentumChaseSignal", () => {
  it("数据不足 25 个点时返回 null", () => {
    expect(computeMomentumChaseSignal(flatSeries(20, 50))).toBeNull();
  });

  it("价格纹丝不动时不判定为追涨", () => {
    const result = computeMomentumChaseSignal(flatSeries(30, 50));
    expect(result).not.toBeNull();
    expect(result!.isChasing).toBe(false);
    expect(result!.return24h).toBe(0);
  });

  it("过去24小时涨幅超过阈值时判定为追涨", () => {
    const prices = flatSeries(10, 50);
    prices.push(...Array.from({ length: 24 }, (_, i) => 50 * (1 + (0.2 * (i + 1)) / 24)));
    const result = computeMomentumChaseSignal(prices)!;
    expect(result.return24h).toBeCloseTo(0.2, 5);
    expect(result.isChasing).toBe(true);
  });

  it("涨幅不够大时不判定为追涨", () => {
    const prices = flatSeries(10, 50);
    prices.push(...Array.from({ length: 24 }, (_, i) => 50 * (1 + (0.05 * (i + 1)) / 24)));
    const result = computeMomentumChaseSignal(prices)!;
    expect(result.return24h).toBeCloseTo(0.05, 5);
    expect(result.isChasing).toBe(false);
  });

  it("过去24小时下跌时不判定为追涨", () => {
    const prices = flatSeries(10, 50);
    prices.push(...Array.from({ length: 24 }, (_, i) => 50 * (1 - (0.1 * (i + 1)) / 24)));
    const result = computeMomentumChaseSignal(prices)!;
    expect(result.return24h).toBeLessThan(0);
    expect(result.isChasing).toBe(false);
  });
});
