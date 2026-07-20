export interface IWashoutSignalResult {
  isWashout: boolean;
  drawdown: number; // 近 window 小时内从局部高点到当前的最大回撤幅度（小数）
  volatility: number; // 同窗口内小时涨跌幅的波动率（标准差）
}

// 回撤窗口：REPORT-B2.md 里洗盘簇（c0）的段落时长中位数是 52 小时——比这个短的深跌
// 大概率只是单笔挂单造成的瞬时波动，比这个长的深跌更可能是趋势性下跌而非洗盘，
// 所以往前看 48 小时找局部高点，而不是用更长的周线窗口。
const DEFAULT_WINDOW_HOURS = 48;

// 回撤阈值：REPORT-B2.md 里洗盘簇最大回撤中位数 20%，最深的单段接近腰斩；
// 相邻的"深跌"簇（c1）最大回撤中位数只有 10.2%——取两者中点 15% 当分界，
// 既不会把普通深跌误判成洗盘，也不会漏掉真实案例（Bullet Rain 17.3%、
// Rocket Pop 18.0%、Phoenix Blacklight 18.9% 都在这条线以上）。
const DEFAULT_DRAWDOWN_THRESHOLD = 0.15;

// 波动率阈值：洗盘簇小时波动率中位数 3.30%，是所有簇里最高的一档（其次是"深跌"
// 簇 1.66%）——只看回撤幅度会把"缓慢阴跌"也算进来，洗盘的特征是"跌得又深又急"，
// 加上波动率门槛才能把两者分开。
const DEFAULT_VOLATILITY_THRESHOLD = 0.02;

/**
 * 洗盘/砸盘信号：识别"近期从局部高点深跌"的形态，对应 REPORT-B2.md 里验证过的
 * 操盘剧本第 4 阶段（洗盘/砸盘）。这是一个提示性的领先信号，不是确定性判断——
 * 报告里的案例显示深回撤接急拉的组合反复出现，但同样的价格形态也可能只是
 * 正常的趋势性下跌，需要用户结合是否已有拉盘迹象、消息面等自行判断。
 *
 * @param hourlyPrices 按时间升序的小时级价格序列
 * @returns 数据不足 window+1 个点时返回 null
 */
export function computeWashoutSignal(
  hourlyPrices: number[],
  options: { window?: number; drawdownThreshold?: number; volatilityThreshold?: number } = {}
): IWashoutSignalResult | null {
  const window = options.window ?? DEFAULT_WINDOW_HOURS;
  const drawdownThreshold = options.drawdownThreshold ?? DEFAULT_DRAWDOWN_THRESHOLD;
  const volatilityThreshold = options.volatilityThreshold ?? DEFAULT_VOLATILITY_THRESHOLD;

  const n = hourlyPrices.length;
  if (n < window + 1) return null;

  const recent = hourlyPrices.slice(n - window - 1); // 含最新一点，共 window+1 个
  const latest = recent[recent.length - 1];

  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const price of recent) {
    peak = Math.max(peak, price);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - price) / peak);
  }
  // 局部高点必须发生在当前点之前才算"跌下来"，不能是当前点自己刚好最高
  const drawdown = peak > latest && peak > 0 ? maxDrawdown : 0;

  const returns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1] > 0) returns.push((recent[i] - recent[i - 1]) / recent[i - 1]);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const volatility = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);

  return {
    isWashout: drawdown >= drawdownThreshold && volatility >= volatilityThreshold,
    drawdown,
    volatility,
  };
}
