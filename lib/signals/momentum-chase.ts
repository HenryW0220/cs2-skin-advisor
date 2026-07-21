export interface IMomentumChaseResult {
  isChasing: boolean;
  return24h: number; // 近 24 小时涨跌幅（小数，正数=上涨）
}

// 阈值来源：REPORT-T7.md 的动量基准分析——用全部价格快照（70万+个时点）按 24h涨幅
// 分桶看未来7天收益，涨幅超过 15% 的桶（占全部时点 3.67%）未来7天平均收益 -10.74%，
// 70.8% 的时点最终是亏的；这个阈值跟 washout.ts 的 15% 回撤阈值同一量级，两个信号
// 分别标记"深跌"和"追高"两种相反的风险形态。
const DEFAULT_RETURN_THRESHOLD = 0.15;

/**
 * 追涨风险信号：识别"过去24小时涨幅过大"的形态。REPORT-T7.md 里最稳定的复现结论——
 * 不需要任何模型，"过去24h涨得最猛的饰品，未来7天大概率是要跌的"这个反向指标本身
 * 就有实操价值，跟"拉盘后急跌洗盘/出货"的业务认知吻合。这是提示性信号，不是确定性
 * 判断——大涨也可能是主拉升的开始（见 REPORT-B2.md 急拉簇），需要用户自行判断。
 *
 * @param hourlyPrices 按时间升序的小时级价格序列
 * @returns 数据不足 25 个点（需要 24 小时前的参照价）时返回 null
 */
export function computeMomentumChaseSignal(
  hourlyPrices: number[],
  options: { returnThreshold?: number } = {}
): IMomentumChaseResult | null {
  const returnThreshold = options.returnThreshold ?? DEFAULT_RETURN_THRESHOLD;

  const n = hourlyPrices.length;
  if (n < 25) return null;

  const latest = hourlyPrices[n - 1];
  const prior24h = hourlyPrices[n - 25];
  if (prior24h <= 0) return null;

  const return24h = (latest - prior24h) / prior24h;

  return {
    isChasing: return24h >= returnThreshold,
    return24h,
  };
}
