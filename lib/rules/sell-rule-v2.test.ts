import { describe, expect, it } from "vitest";
import { evaluateSellV2 } from "./sell-rule-v2";

// 价格序列构造成"平稳 + 末尾按需要变动"，回撤只由末尾几点决定
const flat = (n: number, price = 100) => Array.from({ length: n }, () => price);

describe("evaluateSellV2", () => {
  it("24h 涨幅超过 30% 给强卖出信号", () => {
    const r = evaluateSellV2({ return24h: 0.35, hourlyPrices: flat(48) });
    expect(r.action).toBe("SELL_STRONG");
    expect(r.reason).toContain("18.69");
  });

  it("24h 涨幅 15~30% 给普通卖出信号", () => {
    expect(evaluateSellV2({ return24h: 0.15, hourlyPrices: flat(48) }).action).toBe("SELL");
    expect(evaluateSellV2({ return24h: 0.29, hourlyPrices: flat(48) }).action).toBe("SELL");
  });

  // 数据上显著但经济上不显著，是有意不触发的，别"顺手"把阈值调下来
  it("5~15% 档不触发——超额只有 -3% 上下，扣手续费后不值得换手", () => {
    expect(evaluateSellV2({ return24h: 0.05, hourlyPrices: flat(48) }).action).toBe("HOLD");
    expect(evaluateSellV2({ return24h: 0.149, hourlyPrices: flat(48) }).action).toBe("HOLD");
  });

  it("下跌和横盘不触发", () => {
    expect(evaluateSellV2({ return24h: -0.2, hourlyPrices: flat(48) }).action).toBe("HOLD");
    expect(evaluateSellV2({ return24h: 0, hourlyPrices: flat(48) }).action).toBe("HOLD");
  });

  describe("洗盘否决", () => {
    // 从 100 跌到 80 = 回撤 20%，超过 15% 阈值
    const washoutPrices = [...flat(40), 100, 96, 92, 88, 84, 82, 81, 80];

    it("深回撤 + 低涨幅时明确不卖（回测里这种状态超额收益为正）", () => {
      const r = evaluateSellV2({ return24h: 0.02, hourlyPrices: washoutPrices });
      expect(r.action).toBe("HOLD");
      expect(r.reason).toContain("洗盘");
      expect(r.drawdown48h).toBeGreaterThan(0.15);
    });

    // 20~30% 档在洗盘时超额 -7.03%，比不洗盘时还差，所以否决不该盖过卖出信号
    it("涨幅够大时洗盘否决不生效", () => {
      expect(evaluateSellV2({ return24h: 0.25, hourlyPrices: washoutPrices }).action).toBe("SELL");
      expect(evaluateSellV2({ return24h: 0.4, hourlyPrices: washoutPrices }).action).toBe(
        "SELL_STRONG"
      );
    });

    it("回撤没到 15% 时不算洗盘态", () => {
      const shallow = [...flat(40), 100, 99, 98, 97, 96, 95, 94, 93]; // 回撤 7%
      const r = evaluateSellV2({ return24h: 0.01, hourlyPrices: shallow });
      expect(r.reason).not.toContain("洗盘");
      expect(r.drawdown48h).toBeLessThan(0.15);
    });
  });

  it("价格序列为空时不炸，按无回撤处理", () => {
    const r = evaluateSellV2({ return24h: 0.35, hourlyPrices: [] });
    expect(r.action).toBe("SELL_STRONG");
    expect(r.drawdown48h).toBe(0);
  });

  it("只看最近 48 小时的回撤，更早的高点不算", () => {
    // 前面有个 200 的高点，但已经滑出 48 小时窗口
    const r = evaluateSellV2({ return24h: 0.02, hourlyPrices: [200, ...flat(48, 100)] });
    expect(r.drawdown48h).toBe(0);
    expect(r.action).toBe("HOLD");
  });
});
