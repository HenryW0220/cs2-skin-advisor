import { describe, expect, it } from "vitest";
import { computeManipulationScore } from "./manipulation-score";

function flatSeries(length: number, price: number): number[] {
  return Array.from({ length }, () => price);
}

describe("computeManipulationScore", () => {
  it("数据不足 192 个点时返回 null", () => {
    expect(computeManipulationScore(flatSeries(100, 50))).toBeNull();
  });

  it("价格纹丝不动时嫌疑分为 0", () => {
    const result = computeManipulationScore(flatSeries(300, 50));
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);
    expect(result!.level).toBe("low");
  });

  it("平稳后突然连续暴拉时嫌疑分为 high", () => {
    // 前 276 小时横盘，最后 24 小时每小时 +3%（累计约 +100%，典型拉盘形态）
    const prices = flatSeries(276, 50);
    let p = 50;
    for (let i = 0; i < 24; i++) {
      p *= 1.03;
      prices.push(p);
    }
    const result = computeManipulationScore(prices)!;
    expect(result.level).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.move24h).toBeGreaterThan(0.5);
  });

  it("正常小幅波动时嫌疑分为 low", () => {
    // ±0.2% 的正弦小波动，模拟平时的挂单价起伏
    const prices = Array.from({ length: 300 }, (_, i) => 50 * (1 + 0.002 * Math.sin(i / 5)));
    const result = computeManipulationScore(prices)!;
    expect(result.level).toBe("low");
  });
});
