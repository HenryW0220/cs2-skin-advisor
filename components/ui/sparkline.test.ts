import { describe, expect, it } from "vitest";
import { downsampleForWidth } from "./sparkline";

describe("downsampleForWidth", () => {
  it("点数不超过上限时原样返回", () => {
    const prices = [1, 2, 3, 4, 5];
    expect(downsampleForWidth(prices, 80)).toBe(prices);
  });

  it("超过上限时降到上限点数", () => {
    const prices = Array.from({ length: 169 }, (_, i) => i);
    expect(downsampleForWidth(prices, 80)).toHaveLength(80);
  });

  // 首尾必须保留：末点决定涨跌配色（trendingUp）和图上最新价的位置，
  // 被抽掉的话走势图会显示成错误的颜色。
  it("保留首尾两个点", () => {
    const prices = Array.from({ length: 1000 }, (_, i) => i * 2);
    const sampled = downsampleForWidth(prices, 80);
    expect(sampled[0]).toBe(prices[0]);
    expect(sampled[sampled.length - 1]).toBe(prices[prices.length - 1]);
  });

  it("抽样保持时间顺序，不打乱", () => {
    const prices = Array.from({ length: 500 }, (_, i) => i);
    const sampled = downsampleForWidth(prices, 80);
    for (let i = 1; i < sampled.length; i += 1) {
      expect(sampled[i]).toBeGreaterThan(sampled[i - 1]);
    }
  });
});
