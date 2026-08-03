// 这里**刻意没有成交量项**。2026-08-03 查明：可用的"量"只有 price_snapshots.volume，
// 那是在售挂单数量（存量）不是成交量（流量），小时尺度上根本不会翻倍——实测 325 个饰品
// 的"最新一小时量 / 前 7 小时均值"中位 1.0154、最大 1.2200、达到 2 倍阈值的 0 个，
// 特征分析侧同一个量（volumeRatio）按饰品检验也是 29/67、p=0.889 明确无信号。
// 要重新加回来，先有真实成交笔数数据源，且先拿回测说话（见 lib/rules/sell-rule-v2.ts 的口径）。
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
}

// 规则的权重和阈值都是经验值，不是统计回测出来的，上线观察后如果不准要回来调这里。
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;

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

  if (signals.rsi14 !== null) {
    if (signals.rsi14 >= RSI_OVERBOUGHT) {
      score -= 30;
      reasons.push(`RSI14=${signals.rsi14.toFixed(1)} 超买`);
    } else if (signals.rsi14 <= RSI_OVERSOLD) {
      score += 30;
      reasons.push(`RSI14=${signals.rsi14.toFixed(1)} 超卖`);
    }
  }

  if (signals.ma7 !== null && signals.ma30 !== null) {
    if (signals.ma7 < signals.ma30 && signals.price < signals.ma7) {
      score -= 25;
      reasons.push("价格跌破 MA7，且 MA7 在 MA30 下方，短期趋势走弱");
    } else if (signals.ma7 > signals.ma30 && signals.price > signals.ma7) {
      score += 15;
      reasons.push("价格站上 MA7，且 MA7 在 MA30 上方，短期趋势走强");
    }
  }

  score = Math.max(-100, Math.min(100, score));

  return { action: pickAction(score, context.holding), score, reasons };
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
