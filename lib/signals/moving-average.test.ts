import { describe, expect, it } from "vitest";
import { movingAverage } from "./moving-average";

describe("movingAverage", () => {
  it("用 null 占位数据不够的位置", () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("period 等于数组长度时只有最后一个有值", () => {
    expect(movingAverage([2, 4, 6], 3)).toEqual([null, null, 4]);
  });

  it("period <= 0 抛错", () => {
    expect(() => movingAverage([1, 2, 3], 0)).toThrow();
  });
});
