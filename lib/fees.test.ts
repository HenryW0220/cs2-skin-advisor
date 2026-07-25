import { describe, expect, it } from "vitest";
import { netSellPrice, SELL_FEE_PRESETS } from "./fees";

describe("netSellPrice", () => {
  it("C5 普通费率扣 1%", () => {
    const result = netSellPrice(100, "c5");
    expect(result.net).toBeCloseTo(99, 6);
    expect(result.label).toBe("C5");
  });

  it("C5 会员费率扣 0.5%", () => {
    const result = netSellPrice(100, "c5_vip");
    expect(result.net).toBeCloseTo(99.5, 6);
  });

  it("悠悠有品费率扣 1%", () => {
    const result = netSellPrice(200, "youpin");
    expect(result.net).toBeCloseTo(198, 6);
  });

  it("无手续费费率原价返回", () => {
    const result = netSellPrice(50, "none");
    expect(result.net).toBe(50);
  });

  it("未知费率 key 兜底为无手续费", () => {
    const result = netSellPrice(50, "not-a-real-platform");
    expect(result.net).toBe(50);
    expect(result.label).toBe("无手续费");
  });

  it("gross 为 0 时净价也是 0（不除以 0）", () => {
    const result = netSellPrice(0, "c5");
    expect(result.net).toBe(0);
  });

  it("SELL_FEE_PRESETS 里每个费率都在 [0, 1) 区间", () => {
    for (const preset of SELL_FEE_PRESETS) {
      expect(preset.rate).toBeGreaterThanOrEqual(0);
      expect(preset.rate).toBeLessThan(1);
    }
  });
});
