// 这个规则引擎现在**只剩 RSI 一项**，两个曾经的打分项都是被回测删掉的，别再加回来：
//
// ① 成交量异动（2026-08-03 删）：可用的"量"只有 price_snapshots.volume，那是在售挂单
//    数量（存量）不是成交量（流量），实测 325 个饰品的"最新一小时量 / 前 7 小时均值"
//    中位 1.0154、最大 1.2200，达到 2 倍阈值的 0 个——分支不可达，删掉等价于 no-op。
// ② 均线趋势（2026-08-13 删）：方向**是反的**。同一饰品内部的配对检验（消掉自身漂移）
//    小时尺度 587/713 个饰品「走弱之后反而更好」、差距中位 +1.71%，日尺度 554/652、
//    +5.11%，p 均为 0.0000，而 v1 给走弱 −25、走强 +15。方向反了比没信号更糟——没信号
//    只是不贡献分数，方向反了是在主动往错的方向打分。这跟已验证的短期反转一致
//    （HYPOTHESES.md §3.3、momentum-chase）：涨过头会回落。
//
// 剩下的 RSI 项**方向是对的，但幅度不够触发**：超卖档未来 7 天超额中位只有 +0.61%
// （小时）/ +0.37%（日），而一次往返成本 6.7%~12%。它留在这里是因为方向没错、可以当
// 上下文展示，但页面必须把"这一档赚不回换手成本"显式标出来（lib/rules/cost-line.ts），
// 不许让它看起来像一个可以下单的建议。
//
// 要再往里加项，先过 HYPOTHESES.md 第五节那七关，尤其是第六关（阈值从回测反推）。
import type { ISignalKey } from "./cost-line";

export interface ISignalSnapshot {
  price: number;
  ma7: number | null;
  ma30: number | null;
  rsi14: number | null;
}

export type ITradeAction = "SELL" | "TRIM" | "HOLD" | "WATCH";

export interface IRuleResult {
  action: ITradeAction;
  score: number; // -100（强烈卖出信号）到 100（强烈买入/关注信号）
  reasons: string[];
  /** 本次触发了哪些档，页面和 LLM 靠它去 cost-line.ts 查这一档的历史超额，不要去解析 reasons 文本 */
  signalKeys: ISignalKey[];
}

// 阈值是经验值，RSI 的 70/30 是行业惯例；权重不再是"经验值待调"——删到只剩一项之后，
// score 只是 RSI 状态的另一种写法（+30 / 0 / −30），调它没有独立意义。
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;

// SELL 阈值保持 −40 不动：删掉趋势项之后最负的 score 是 −30，SELL 在结构上不可达。
// **这是有意的**——真实平仓已经交给回测支持的 v2（lib/rules/sell-rule-v2.ts），
// 不该再让一个没有回测依据的 v1 分支去触发卖出。TRIM 的 −15 同理，现在只有超买那档够得到。
const SCORE_SELL_THRESHOLD = -40;
const SCORE_TRIM_THRESHOLD = -15;

// 持仓饰品只会输出 SELL/TRIM/HOLD；观察池饰品（context.holding=false）固定输出 WATCH，
// score 表示现在是不是值得买入的信号强弱。
export function evaluateSignals(
  signals: ISignalSnapshot,
  context: { holding: boolean } = { holding: true }
): IRuleResult {
  let score = 0;
  const reasons: string[] = [];
  const signalKeys: ISignalKey[] = [];

  if (signals.rsi14 !== null) {
    if (signals.rsi14 >= RSI_OVERBOUGHT) {
      score -= 30;
      reasons.push(`RSI14=${signals.rsi14.toFixed(1)} 超买`);
      signalKeys.push("rsi_overbought");
    } else if (signals.rsi14 <= RSI_OVERSOLD) {
      score += 30;
      reasons.push(`RSI14=${signals.rsi14.toFixed(1)} 超卖`);
      signalKeys.push("rsi_oversold");
    }
  }

  score = Math.max(-100, Math.min(100, score));

  return { action: pickAction(score, context.holding), score, reasons, signalKeys };
}

function pickAction(score: number, holding: boolean): ITradeAction {
  if (!holding) return "WATCH";
  if (score <= SCORE_SELL_THRESHOLD) return "SELL";
  if (score <= SCORE_TRIM_THRESHOLD) return "TRIM";
  return "HOLD";
}

export const RULE_THRESHOLDS = {
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  SCORE_SELL_THRESHOLD,
  SCORE_TRIM_THRESHOLD,
};
