export interface ISignalSnapshot {
  price: number;
  ma7: number | null;
  ma30: number | null;
  rsi14: number | null;
  volumeAnomalyRatio: number | null; // 来自 detectVolumeAnomaly 的 ratio，没算过就传 null
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
const VOLUME_ANOMALY_THRESHOLD = 2;

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

  if (signals.volumeAnomalyRatio !== null && signals.volumeAnomalyRatio >= VOLUME_ANOMALY_THRESHOLD) {
    if (score < 0) {
      score -= 15;
      reasons.push(`成交量放大 ${signals.volumeAnomalyRatio.toFixed(1)} 倍，下跌信号增强`);
    } else if (score > 0) {
      score += 10;
      reasons.push(`成交量放大 ${signals.volumeAnomalyRatio.toFixed(1)} 倍，上涨信号增强`);
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
  VOLUME_ANOMALY_THRESHOLD,
  SCORE_SELL_THRESHOLD,
  SCORE_TRIM_THRESHOLD,
};
