import { describe, expect, it } from "vitest";
import { computeWashoutSignal } from "./washout";

function flatSeries(length: number, price: number): number[] {
  return Array.from({ length }, () => price);
}

describe("computeWashoutSignal", () => {
  it("数据不足 window+1 个点时返回 null", () => {
    expect(computeWashoutSignal(flatSeries(30, 50))).toBeNull();
  });

  it("价格纹丝不动时不判定为洗盘", () => {
    const result = computeWashoutSignal(flatSeries(60, 50));
    expect(result).not.toBeNull();
    expect(result!.isWashout).toBe(false);
    expect(result!.drawdown).toBe(0);
  });

  it("近期深跌且波动剧烈时判定为洗盘", () => {
    // 整个 48 小时窗口逐步交替大跌 4%/小涨 1%，净跌约 52%、波动率约 2.5%，
    // 峰值就在窗口起点，模拟"从高点急跌下来"的洗盘形态
    const prices = [100];
    for (let i = 0; i < 48; i++) {
      const ret = i % 2 === 0 ? -0.04 : 0.01;
      prices.push(prices[prices.length - 1] * (1 + ret));
    }
    const result = computeWashoutSignal(prices)!;
    expect(result.isWashout).toBe(true);
    expect(result.drawdown).toBeGreaterThanOrEqual(0.15);
  });

  it("缓慢阴跌（回撤够深但波动率低）不判定为洗盘", () => {
    // 48 小时匀速小幅下跌到回撤 20%，每步跌幅均匀、波动率很低
    const prices: number[] = [100];
    for (let i = 0; i < 48; i++) prices.push(prices[prices.length - 1] * 0.9955);
    const result = computeWashoutSignal(prices)!;
    expect(result.drawdown).toBeGreaterThanOrEqual(0.15);
    expect(result.isWashout).toBe(false);
  });

  it("回撤不够深时即使波动大也不判定为洗盘", () => {
    // 整个窗口涨跌交替各 3%，围绕基准小幅震荡，波动率高但没有形成深回撤
    const prices = [100];
    for (let i = 0; i < 48; i++) {
      const ret = i % 2 === 0 ? 0.03 : -0.03;
      prices.push(prices[prices.length - 1] * (1 + ret));
    }
    const result = computeWashoutSignal(prices)!;
    expect(result.drawdown).toBeLessThan(0.15);
    expect(result.isWashout).toBe(false);
  });
});
