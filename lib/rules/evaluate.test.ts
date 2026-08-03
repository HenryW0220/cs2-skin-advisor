import { describe, expect, it } from "vitest";
import { evaluateSignals, RULE_THRESHOLDS } from "./evaluate";

describe("evaluateSignals", () => {
  it("超买 + 跌破均线 时持仓应该 SELL", () => {
    const result = evaluateSignals(
      {
        price: 90,
        ma7: 95,
        ma30: 100,
        rsi14: 75,
      },
      { holding: true }
    );
    expect(result.action).toBe("SELL");
    expect(result.score).toBeLessThanOrEqual(-40);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("没有明显信号时持仓应该 HOLD，score 为 0", () => {
    const result = evaluateSignals(
      { price: 100, ma7: null, ma30: null, rsi14: 50 },
      { holding: true }
    );
    expect(result).toEqual({ action: "HOLD", score: 0, reasons: [] });
  });

  it("观察池饰品永远输出 WATCH，不管信号好坏", () => {
    const bullish = evaluateSignals(
      { price: 100, ma7: 105, ma30: 100, rsi14: 25 },
      { holding: false }
    );
    const bearish = evaluateSignals(
      { price: 90, ma7: 95, ma30: 100, rsi14: 80 },
      { holding: false }
    );
    expect(bullish.action).toBe("WATCH");
    expect(bearish.action).toBe("WATCH");
    expect(bullish.score).toBeGreaterThan(bearish.score);
  });

  it("超卖 + 均线走强 时持仓应该 HOLD（score 为正不会触发卖出阈值）", () => {
    const result = evaluateSignals(
      { price: 105, ma7: 103, ma30: 100, rsi14: 25 },
      { holding: true }
    );
    expect(result.action).toBe("HOLD");
    expect(result.score).toBeGreaterThan(0);
  });

  // 这条锁住的是**规则引擎能产出哪些分数**这个事实本身。2026-08-03 删掉成交量项时，
  // 判断"删了等价于没删"的依据就是"实测 325 个饰品没有一个能触发那一项"；把可达分值
  // 枚举出来，以后谁再动权重都会先在这里看到影响面（尤其是 SELL 门槛 -40：现在只有
  // 超买(-30) + 趋势走弱(-25) = -55 这一条路能够到，实测全库同时满足的是 0 个）。
  it("可达的 score 集合是固定的 9 个值，SELL 只有 -55 一条路", () => {
    const rsiCases = [null, 75, 25, 50]; // 无数据 / 超买 / 超卖 / 中性
    const maCases: { ma7: number | null; ma30: number | null; price: number }[] = [
      { ma7: null, ma30: null, price: 100 }, // 无数据
      { ma7: 95, ma30: 100, price: 90 }, // 趋势走弱
      { ma7: 105, ma30: 100, price: 110 }, // 趋势走强
      { ma7: 100, ma30: 100, price: 100 }, // 中性
    ];

    const scores = new Set<number>();
    const sellInputs: number[] = [];
    for (const rsi14 of rsiCases) {
      for (const ma of maCases) {
        const result = evaluateSignals({ ...ma, rsi14 }, { holding: true });
        scores.add(result.score);
        if (result.action === "SELL") sellInputs.push(result.score);
      }
    }

    expect([...scores].sort((a, b) => a - b)).toEqual([-55, -30, -25, -15, 0, 5, 15, 30, 45]);
    expect([...new Set(sellInputs)]).toEqual([-55]);
    // 夹取区间比可达范围宽得多，纯防御；写出来是为了说明它现在不是活跃约束
    expect(Math.min(...scores)).toBeGreaterThan(-100);
    expect(Math.max(...scores)).toBeLessThan(100);
    expect(RULE_THRESHOLDS.SCORE_SELL_THRESHOLD).toBe(-40);
  });
});
