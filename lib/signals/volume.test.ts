import { describe, expect, it } from "vitest";
import { detectVolumeAnomaly } from "./volume";

describe("detectVolumeAnomaly", () => {
  it("最新成交量超过历史均值 threshold 倍时判定异动", () => {
    const result = detectVolumeAnomaly([10, 10, 10, 30], { window: 3, threshold: 2 });
    expect(result).toEqual({
      isAnomaly: true,
      latestVolume: 30,
      averageVolume: 10,
      ratio: 3,
    });
  });

  it("没有明显放量时不判定异动", () => {
    const result = detectVolumeAnomaly([10, 10, 10, 12], { window: 3, threshold: 2 });
    expect(result?.isAnomaly).toBe(false);
  });

  it("数据不够 window+1 期时返回 null", () => {
    expect(detectVolumeAnomaly([10, 10], { window: 3 })).toBeNull();
  });
});
