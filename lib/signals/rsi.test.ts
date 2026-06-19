import { describe, expect, it } from "vitest";
import { rsi } from "./rsi";

describe("rsi", () => {
  it("持续上涨时 RSI 接近 100", () => {
    const values = Array.from({ length: 15 }, (_, i) => i + 1); // 1..15，每步 +1
    const result = rsi(values, 14);
    expect(result[14]).toBe(100);
    expect(result.slice(0, 14)).toEqual(new Array(14).fill(null));
  });

  it("持续下跌时 RSI 为 0", () => {
    const values = Array.from({ length: 15 }, (_, i) => 15 - i); // 15..1，每步 -1
    const result = rsi(values, 14);
    expect(result[14]).toBe(0);
  });

  it("数据不够 period 时全是 null", () => {
    const values = [1, 2, 3];
    expect(rsi(values, 14)).toEqual([null, null, null]);
  });
});
