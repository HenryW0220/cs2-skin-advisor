import { describe, expect, it } from "vitest";
import { ROUND_TRIP_COST_MIN, SIGNAL_EVIDENCE, evidenceForScore, isActionable } from "./cost-line";
import { evaluateSignals, RULE_THRESHOLDS } from "./evaluate";

describe("evaluateSignals", () => {
  it("超买时持仓输出 TRIM（−30 够 TRIM 但够不到 SELL）", () => {
    const result = evaluateSignals(
      { price: 90, ma7: 95, ma30: 100, rsi14: 75 },
      { holding: true }
    );
    expect(result.action).toBe("TRIM");
    expect(result.score).toBe(-30);
    expect(result.signalKeys).toEqual(["rsi_overbought"]);
  });

  it("没有明显信号时持仓应该 HOLD，score 为 0", () => {
    const result = evaluateSignals(
      { price: 100, ma7: null, ma30: null, rsi14: 50 },
      { holding: true }
    );
    expect(result).toEqual({ action: "HOLD", score: 0, reasons: [], signalKeys: [] });
  });

  it("观察池饰品永远输出 WATCH，不管信号好坏", () => {
    const bullish = evaluateSignals(
      { price: 100, ma7: 105, ma30: 100, rsi14: 25 },
      { holding: false }
    );
    const bearish = evaluateSignals(
      { price: 90, ma7: 95, ma30: 100, rsi14: 80 },
      { holding: false }
    );
    expect(bullish.action).toBe("WATCH");
    expect(bearish.action).toBe("WATCH");
    expect(bullish.score).toBeGreaterThan(bearish.score);
  });

  // 2026-08-13 删掉均线趋势项之后锁的第一条：均线数据再怎么摆都不能改变结论。
  // 删它的依据是配对检验里方向反了（走弱之后反而跑赢，587/713，p=0.0000），
  // 所以"趋势走弱要不要减仓"这个问题现在的正确答案是"不参与打分"。
  it("均线状态不再影响 score——趋势项已删除", () => {
    const rsiNeutral = { rsi14: 50 };
    const weak = evaluateSignals({ price: 90, ma7: 95, ma30: 100, ...rsiNeutral });
    const strong = evaluateSignals({ price: 110, ma7: 105, ma30: 100, ...rsiNeutral });
    const flat = evaluateSignals({ price: 100, ma7: 100, ma30: 100, ...rsiNeutral });

    expect(weak.score).toBe(0);
    expect(strong.score).toBe(0);
    expect(flat.score).toBe(0);
    expect(weak.reasons).toEqual([]);
    expect(strong.reasons).toEqual([]);
  });

  // 这条锁住的是**规则引擎能产出哪些分数**这个事实本身。删掉成交量项（2026-08-03）和
  // 趋势项（2026-08-13）之后只剩 RSI 单因子，可达 score 塌缩成三个值。
  // SELL 从此结构上不可达是**有意的**：真实平仓已交给有回测依据的 v2。
  it("可达的 score 集合塌缩成 3 个值，SELL 不可达", () => {
    const rsiCases = [null, 75, 25, 50]; // 无数据 / 超买 / 超卖 / 中性
    const maCases: { ma7: number | null; ma30: number | null; price: number }[] = [
      { ma7: null, ma30: null, price: 100 }, // 无数据
      { ma7: 95, ma30: 100, price: 90 }, // 曾经的"趋势走弱"
      { ma7: 105, ma30: 100, price: 110 }, // 曾经的"趋势走强"
      { ma7: 100, ma30: 100, price: 100 }, // 中性
    ];

    const scores = new Set<number>();
    const actions = new Set<string>();
    for (const rsi14 of rsiCases) {
      for (const ma of maCases) {
        const result = evaluateSignals({ ...ma, rsi14 }, { holding: true });
        scores.add(result.score);
        actions.add(result.action);
      }
    }

    expect([...scores].sort((a, b) => a - b)).toEqual([-30, 0, 30]);
    expect([...actions].sort()).toEqual(["HOLD", "TRIM"]);
    expect(Math.min(...scores)).toBeGreaterThan(RULE_THRESHOLDS.SCORE_SELL_THRESHOLD);
  });
});

describe("成本线", () => {
  // 这条测试锁的是一个结论而不是一段逻辑：v1 剩下的两档**都赚不回一次换手的成本**。
  // 哪天有人把某一档的实测数字改大到够得着成本线，这里会失败，逼他回来解释依据。
  it("RSI 两档的历史超额都够不着 6.7% 的往返成本下界", () => {
    for (const evidence of Object.values(SIGNAL_EVIDENCE)) {
      expect(Math.abs(evidence.excess7d)).toBeLessThan(ROUND_TRIP_COST_MIN);
      expect(isActionable(evidence)).toBe(false);
    }
  });

  it("成本线下界是 6.7%——买卖价差中位 5.72% + C5 手续费 1%", () => {
    expect(ROUND_TRIP_COST_MIN).toBeCloseTo(0.067, 5);
  });

  // 页面靠 score 反推触发档（预计算表里没存 signalKeys）。这条测试把那个映射跟规则引擎的
  // 真实输出对齐——再加任何一个打分项，score 和 signalKeys 就不再一一对应，这里会先炸。
  it("evidenceForScore 和 evaluateSignals 的 signalKeys 一一对应", () => {
    const cases = [
      { rsi14: 75, price: 100, ma7: null, ma30: null },
      { rsi14: 25, price: 100, ma7: null, ma30: null },
      { rsi14: 50, price: 100, ma7: null, ma30: null },
      { rsi14: null, price: 100, ma7: null, ma30: null },
    ];

    for (const input of cases) {
      const result = evaluateSignals(input, { holding: true });
      const fromScore = evidenceForScore(result.score);
      expect(fromScore?.key ?? null).toBe(result.signalKeys[0] ?? null);
      expect(result.signalKeys.length).toBeLessThanOrEqual(1);
    }
  });
});
