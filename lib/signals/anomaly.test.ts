import { describe, expect, it } from "vitest";
import { detectPriceZScoreAnomaly, scanPriceZScoreAnomalies } from "./anomaly";

// window=3 时基线是"这一步之前 3 步涨跌幅"，构造一段稳定在 0 涨跌幅、
// 最后一步突然大涨的序列来验证 z-score 能识别出来。
function buildStablePricesWithSpike(stableSteps: number, spikeReturn: number): number[] {
  const prices = [100];
  for (let i = 0; i < stableSteps; i++) prices.push(prices[prices.length - 1]);
  const last = prices[prices.length - 1];
  prices.push(last * (1 + spikeReturn));
  return prices;
}

describe("detectPriceZScoreAnomaly", () => {
  it("平稳序列突然大涨时判定异常", () => {
    const prices = buildStablePricesWithSpike(5, 0.5); // window+2 至少要 5
    const result = detectPriceZScoreAnomaly(prices, { window: 4, threshold: 3 });
    expect(result?.isAnomaly).toBe(true);
    expect(result?.latestReturn).toBeCloseTo(0.5);
  });

  it("持续平稳没有异常", () => {
    const prices = [100, 100, 100, 100, 100, 100, 100];
    const result = detectPriceZScoreAnomaly(prices, { window: 4, threshold: 3 });
    expect(result?.isAnomaly).toBe(false);
    expect(result?.zScore).toBe(0);
  });

  it("正常波动幅度内不会被误判为异常", () => {
    // 每一步都在 -1%~+1% 之间随机波动，最后一步也在同样范围内，不该被标记异常。
    const prices = [100, 101, 99.5, 100.8, 99.7, 100.3, 99.9, 100.5];
    const result = detectPriceZScoreAnomaly(prices, { window: 5, threshold: 3 });
    expect(result?.isAnomaly).toBe(false);
  });

  it("数据不够 window+2 期时返回 null", () => {
    expect(detectPriceZScoreAnomaly([100, 101, 102], { window: 10 })).toBeNull();
  });

  it("价格为 0 的点会被跳过，不参与涨跌幅计算，也不影响下标映射", () => {
    // prices[6]=0 这一步不产生涨跌幅，跳过后 priceIndex 仍要精确指回 prices 数组的真实下标，
    // 不能按"涨跌幅序列长度 - 1"去反推（那样会因为少了一步而错位）。
    const prices = [100, 100, 100, 100, 100, 100, 0, 100, 200];
    const result = detectPriceZScoreAnomaly(prices, { window: 4, threshold: 2 });
    // 最新一步 100 -> 200 是 +100%，priceIndex 应该指向 prices 里最后一个下标（8）
    expect(result?.priceIndex).toBe(8);
    expect(result?.latestReturn).toBeCloseTo(1);
    expect(result?.isAnomaly).toBe(true);
  });
});

describe("scanPriceZScoreAnomalies", () => {
  it("对整段历史逐点扫描，只标出真正的异常点", () => {
    const prices = [100, 100, 100, 100, 100, 150, 150, 150, 150, 150];
    const results = scanPriceZScoreAnomalies(prices, { window: 4, threshold: 3 });
    const anomalies = results.filter((r) => r.isAnomaly);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].priceIndex).toBe(5); // 100 -> 150 那一步
  });
});
