export interface IPriceZScoreResult {
  priceIndex: number; // 对应 prices 数组里的下标（不是涨跌幅序列的下标）
  latestReturn: number; // 这一步相对上一步的涨跌幅（小数，非百分比）
  mean: number;
  stddev: number;
  zScore: number;
  isAnomaly: boolean;
}

interface IReturnPoint {
  value: number;
  priceIndex: number; // 这个涨跌幅对应 prices 里的哪个下标（"新"的那个价格）
}

// 价格为 0（挂不出价/接口没覆盖的死数据）时这一步没法算涨跌幅，跳过——
// 跳过的点不进涨跌幅序列，所以每个涨跌幅要单独记住自己对应 prices 的哪个下标，
// 不能假设涨跌幅序列的下标 = prices 下标 - 1（有跳过就对不上了）。
function computeReturns(prices: number[]): IReturnPoint[] {
  const returns: IReturnPoint[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] === 0) continue;
    returns.push({ value: (prices[i] - prices[i - 1]) / prices[i - 1], priceIndex: i });
  }
  return returns;
}

// 价格波动的统计异常检测：把"某一步涨跌幅"跟"它之前 window 步涨跌幅的均值/标准差"比，
// 算出 z-score，对涨跌幅序列里每一个够得上基线长度的点都算一遍（不止最新一点）。
// 跟 lib/rules/evaluate.ts 里 RSI/MA 那套"技术面判断"不是一回事——这里不关心价格
// 处在什么位置，只关心"这一步波动相对这个饰品自己的历史正常不正常"，更适合捕捉
// 操盘特有的"平时很稳，突然一步跳很大"的模式。
//
// window 默认 168（每小时同步一次时约等于最近 7 天）：太短基线不稳定，太长会把
// 早期的操盘期也混进"正常"基线里，反而钝化了对新一轮操盘的敏感度。
// 用滑动窗口累加均值/方差而不是每一步重新遍历整个 window，是因为这个函数要拿去
// 对回填的 90 天完整历史做回溯扫描（成百上千个点 × 上百个持仓），O(n) 而不是
// O(n·window) 才跑得动。
// 实测确认：饰品市场（尤其低流动性的品）挂单薄，正常情况下单笔成交就能让价格跳
// 好几个百分点，按正态分布假设的 3 倍标准差在这里完全不够格——105 个持仓测下来
// 阈值 3 会命中 4766 条，平均每个饰品 45 条，根本没法人工审核。阈值 6 收窄到十分之一
// 左右（约 1100 条），实测这个量级基本都是真的一步跳变很大的点，不是噪音。
const DEFAULT_PRICE_ZSCORE_THRESHOLD = 6;

// 极低价饰品（印花几分钱这种）在基线波动本身接近 0 时，任何一点浮点精度噪音都会
// 被除法放大成天文数字的 z-score（实测见过 6 亿）——这不是发现了更极端的异常，
// 只是分母趋近于 0 的数值病态。给标准差设一个下限（1% 的相对波动）压住这个问题：
// 基线真的稳定在 1% 以内时，波动要相对基线本身够大（比 1% 明显大很多）才会被标记异常，
// 而不是随便一点噪音都能除出天文数字。
const MIN_STDDEV = 0.01;

export function scanPriceZScoreAnomalies(
  prices: number[],
  options: { window?: number; threshold?: number } = {}
): IPriceZScoreResult[] {
  const window = options.window ?? 168;
  const threshold = options.threshold ?? DEFAULT_PRICE_ZSCORE_THRESHOLD;

  const returns = computeReturns(prices);
  if (returns.length < window + 1) return [];

  const results: IPriceZScoreResult[] = [];
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < window; i++) {
    sum += returns[i].value;
    sumSq += returns[i].value ** 2;
  }

  for (let idx = window; idx < returns.length; idx++) {
    const mean = sum / window;
    const variance = Math.max(sumSq / window - mean * mean, 0);
    const stddev = Math.max(Math.sqrt(variance), MIN_STDDEV);
    const latestReturn = returns[idx].value;
    const zScore = (latestReturn - mean) / stddev;

    results.push({
      priceIndex: returns[idx].priceIndex,
      latestReturn,
      mean,
      stddev,
      zScore,
      isAnomaly: Math.abs(zScore) >= threshold,
    });

    // 基线永远是"这一步之前"的 window 步，不含这一步自己——滑动到下一步时把
    // 窗口最早的一步移出、把刚测完的这一步移入。
    const outgoing = returns[idx - window].value;
    sum += returns[idx].value - outgoing;
    sumSq += returns[idx].value ** 2 - outgoing ** 2;
  }

  return results;
}

// 只关心最新一点是否异常时用这个（每小时同步后的实时检测）。
export function detectPriceZScoreAnomaly(
  prices: number[],
  options: { window?: number; threshold?: number } = {}
): IPriceZScoreResult | null {
  const results = scanPriceZScoreAnomalies(prices, options);
  return results.length > 0 ? results[results.length - 1] : null;
}
