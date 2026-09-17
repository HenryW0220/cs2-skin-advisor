// RSI（相对强弱指标），用 Wilder 平滑法（行业标准做法，不是简单移动平均）。
// ⚠️ 第二份实现在 scripts/build-rsi-trend-baseline.mjs（阈值就是从那边反推的），改这里要同步那边。
// 两边逐位相同已由 lib/signals/cross-impl-parity.test.ts 锁住。背景见 HANDOFF 第四节 0.5。
// 返回数组长度跟输入一致，前 period 个位置数据不够填 null。
export function rsi(values: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return result;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  result[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    // Wilder 平滑：新值只占 1/period 权重，不是简单移动窗口
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = rsiFromAverages(avgGain, avgLoss);
  }

  return result;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
