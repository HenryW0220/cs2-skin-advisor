import { describe, expect, it } from "vitest";
import { computeCrossPlatformSpread } from "./cross-platform";

describe("computeCrossPlatformSpread", () => {
  it("找出最便宜和最贵的平台并计算价差", () => {
    const result = computeCrossPlatformSpread([
      { platform: "C5", price: 200 },
      { platform: "STEAM", price: 250 },
      { platform: "BUFF", price: 0 }, // 缺货/未上架，应该被过滤
    ]);
    expect(result).toEqual({
      cheapest: { platform: "C5", price: 200 },
      mostExpensive: { platform: "STEAM", price: 250 },
      spread: 50,
      spreadPercent: 0.25,
    });
  });

  it("有效平台少于 2 个时返回 null", () => {
    expect(computeCrossPlatformSpread([{ platform: "C5", price: 200 }])).toBeNull();
  });
});
