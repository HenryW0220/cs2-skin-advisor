import { describe, expect, it } from "vitest";
import { evaluateSignals } from "./evaluate";

describe("evaluateSignals", () => {
  it("超买 + 跌破均线 + 放量 时持仓应该 SELL", () => {
    const result = evaluateSignals(
      {
        price: 90,
        ma7: 95,
        ma30: 100,
        rsi14: 75,
        volumeAnomalyRatio: 3,
      },
      { holding: true }
    );
    expect(result.action).toBe("SELL");
    expect(result.score).toBeLessThanOrEqual(-40);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("没有明显信号时持仓应该 HOLD，score 为 0", () => {
    const result = evaluateSignals(
      { price: 100, ma7: null, ma30: null, rsi14: 50, volumeAnomalyRatio: null },
      { holding: true }
    );
    expect(result).toEqual({ action: "HOLD", score: 0, reasons: [] });
  });

  it("观察池饰品永远输出 WATCH，不管信号好坏", () => {
    const bullish = evaluateSignals(
      { price: 100, ma7: 105, ma30: 100, rsi14: 25, volumeAnomalyRatio: null },
      { holding: false }
    );
    const bearish = evaluateSignals(
      { price: 90, ma7: 95, ma30: 100, rsi14: 80, volumeAnomalyRatio: 5 },
      { holding: false }
    );
    expect(bullish.action).toBe("WATCH");
    expect(bearish.action).toBe("WATCH");
    expect(bullish.score).toBeGreaterThan(bearish.score);
  });

  it("超卖 + 均线走强 时持仓应该 HOLD（score 为正不会触发卖出阈值）", () => {
    const result = evaluateSignals(
      { price: 105, ma7: 103, ma30: 100, rsi14: 25, volumeAnomalyRatio: 2.5 },
      { holding: true }
    );
    expect(result.action).toBe("HOLD");
    expect(result.score).toBeGreaterThan(0);
  });

  it("score 会被夹在 [-100, 100] 区间内", () => {
    const result = evaluateSignals(
      { price: 50, ma7: 60, ma30: 100, rsi14: 90, volumeAnomalyRatio: 10 },
      { holding: true }
    );
    expect(result.score).toBeGreaterThanOrEqual(-100);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
