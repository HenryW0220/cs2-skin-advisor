export interface IManipulationScoreResult {
  score: number; // 0-100，越高越像处于操盘期
  level: "high" | "medium" | "low";
  // 原始特征值，给 UI/LLM 解释用
  volatility24h: number;
  move24h: number;
  maDeviation: number;
}

/**
 * 操盘嫌疑分 v1：判断一个饰品**当前是否处于操盘期**（不是预测未来会不会被操盘）。
 *
 * 特征和权重不是拍脑袋——来自 scripts/analyze-manipulation-features.mjs 对真实标注
 * （2026-07 用户确认的 138 个操盘窗口，1 万+ 操盘期小时样本 vs 7 万+ 平时样本）的
 * 区分度分析，只保留 AUC 明显高于 0.5 的特征：
 *   - 24h 滚动波动率  AUC 0.72（操盘期中位数 0.0154 vs 平时 0.0064）
 *   - 24h 累计涨跌幅  AUC 0.66（0.047 vs 0.019）
 *   - 偏离 168h 均线   AUC 0.62（0.055 vs 0.032）
 * 单小时尖峰类特征（1h z-score）AUC 仅 0.52，被排除——操盘窗口持续数天，多数时刻
 * 是"控盘中"而非"正在暴拉"。同收藏品联动特征当前标注下验证不出区分度，留待样本
 * 积累后重估。标注更新后要重跑分析脚本回来调这些阈值。
 *
 * @param hourlyPrices 按时间升序的小时级价格序列（用 K 线回填后的 price_snapshots）
 * @returns 数据不足 192 个点（约 8 天）时返回 null
 */
export function computeManipulationScore(hourlyPrices: number[]): IManipulationScoreResult | null {
  const n = hourlyPrices.length;
  if (n < 192) return null;

  const returns: number[] = [];
  for (let i = 1; i < n; i++) {
    if (hourlyPrices[i - 1] > 0) returns.push((hourlyPrices[i] - hourlyPrices[i - 1]) / hourlyPrices[i - 1]);
  }
  if (returns.length < 24) return null;

  // ⚠️ **这一行的 vol24h 跟 `scripts/analyze-manipulation-features.mjs` 差一格，不要单边改。**
  // 这里 `slice(-24)` **含当前小时**；那边 `returns.slice(Math.max(1, i-24), i)` **不含**。
  // 下面 ramp 用的 0.0064 / 0.031 两个锚点、以及 AUC 0.819，**都是那边算出来的**，
  // 所以那两个数没有落在这一行算的量上。实测 300/300 全不同、最大差 0.00163（见下方对拍测试）。
  // 未修，因为改哪边都会动已发布的数字，要项目所有者拍板 —— HANDOFF 第四节 0.5 与 §0.9。
  // 对拍与变异测试：`lib/signals/cross-impl-parity.test.ts`，改任一边那组会红。
  const last24 = returns.slice(-24);
  const volatility24h = Math.sqrt(last24.reduce((s, r) => s + r * r, 0) / last24.length);

  const prev24Price = hourlyPrices[n - 25];
  const move24h = prev24Price > 0 ? Math.abs(hourlyPrices[n - 1] - prev24Price) / prev24Price : 0;

  const window168 = hourlyPrices.slice(-169, -1);
  const ma168 = window168.reduce((s, p) => s + p, 0) / window168.length;
  const maDeviation = ma168 > 0 ? Math.abs(hourlyPrices[n - 1] - ma168) / ma168 : 0;

  // ramp(lo→hi 线性拉满)：lo 取平时中位数（此处应得 0 分），hi 取操盘期中位数的 2 倍
  const ramp = (x: number, lo: number, hi: number) => Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  const score = Math.round(
    100 *
      (0.45 * ramp(volatility24h, 0.0064, 0.031) +
        0.3 * ramp(move24h, 0.019, 0.094) +
        0.25 * ramp(maDeviation, 0.032, 0.11))
  );

  return {
    score,
    level: score >= 60 ? "high" : score >= 35 ? "medium" : "low",
    volatility24h,
    move24h,
    maDeviation,
  };
}
