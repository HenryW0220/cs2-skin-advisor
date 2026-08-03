/**
 * 卖出规则 v2（影子规则，2026-08-03）。
 *
 * **现在只在模拟盘里并行记录，不参与任何真实决策、不影响页面上的买卖建议。**
 * 替换 v1（`lib/rules/evaluate.ts` 的卖出侧）之前必须先拿到触发次数和假信号率，
 * 这是项目所有者定的口径。
 *
 * 为什么要有 v2：v1 的卖出侧在结构上**永远触发不了**——SELL 要 score ≤ -40，
 * 而全库 325 个饰品最负的 score 是 -30；能补足差额的"成交量异动"项又是死信号
 * （喂进去的是在售量这个存量，实测比值中位数恰好 1.000，达标 0 个）。
 * 详见 HANDOFF 踩坑 43。
 *
 * ---- 每个阈值的依据 ----
 * 全部来自 `scripts/build-sell-rule-baseline.mjs` 的回测（714 个饰品、99 天大盘基准，
 * 口径：某时点的"未来 7 天收益 − 当天全市场中位数"，即**扣掉大盘 beta 之后的超额**；
 * 只看中位数不看均值，因为皮肤价格是重尾分布、均值会被几个低价品主导）：
 *
 *   24h涨幅档  超额中位数   为负占比   有该档的饰品数/中位数为负的   符号检验p
 *   跌         +0.20%      48.5%     714 / 307                   0.9999  ← 无信号
 *   0~5%       +0.15%      48.5%     714 / 360                   0.4258  ← 无信号
 *   5~10%      -2.75%      63.2%     638 / 495                   0.0000
 *   10~15%     -3.17%      59.3%     447 / 293                   0.0000
 *   15~20%     -4.35%      61.4%     310 / 198                   0.0000
 *   20~30%     -5.89%      61.5%     258 / 161                   0.0000
 *   >30%      -18.69%      71.4%     203 / 155                   0.0000
 *
 * - **STRONG 阈值取 30%**：这一档超额中位数 -18.69%、71.4% 为负，比相邻档陡一个数量级，
 *   是整张表唯一的台阶。（71.4% 这个数字跟 REPORT-t7-actionable-labels.md 独立算出来的
 *   "70.8% 概率为负"几乎一致，两条不同路径互相印证。）
 * - **NORMAL 阈值取 15%**：-4.35% 超额，扣掉 C5 1% 手续费后仍有明确余量；
 *   同时它正好是 REPORT-t7 已验证过的追涨阈值，两处对得上。
 * - **5~15% 不作为触发条件**：超额只有 -2.75%~-3.17%，扣掉手续费和买卖价差后所剩无几，
 *   为这个量级频繁换手不划算。数据上显著（p=0.0000）但经济上不显著，是两回事。
 * - **洗盘态否决**：48 小时回撤 >15% 且 24h 涨幅 <5% 时，超额中位数反而是 **+3.69%/+2.09%**
 *   （深回撤之后倾向反弹，跟 REPORT-manipulation-playbook-stages.md 的洗盘指纹、
 *   以及两版预测基线里 drawdown48h 是最大正权重特征三处一致），所以这种状态明确不卖。
 *   注意这个否决只在低涨幅档成立——20~30% 档在洗盘时超额是 -7.03%，比不洗盘还差。
 *
 * ---- 刻意没有放进来的东西 ----
 * RSI 超买、均线趋势、成交量异动这三项**没有任何回测支撑**（v1 里的权重是当初拍的经验值），
 * 按项目所有者定的口径不进规则。成交量那项还额外是死信号。以后要加，先拿回测数据说话。
 */

/** 48 小时回撤超过这个幅度算洗盘态，跟 lib/signals/washout.ts 同一个定义 */
const WASHOUT_DRAWDOWN = 0.15;
/** 洗盘否决只在 24h 涨幅低于这个值时生效（回测里 0~5% 档洗盘时超额 +2.09%） */
const WASHOUT_VETO_MAX_RETURN = 0.05;
const SELL_NORMAL_RETURN = 0.15;
const SELL_STRONG_RETURN = 0.3;
/** 算回撤要看的小时数 */
const DRAWDOWN_WINDOW_HOURS = 48;

export type ISellV2Action = "SELL_STRONG" | "SELL" | "HOLD";

export interface ISellV2Input {
  /** 最近 24 小时涨跌幅，**小数不是百分数**（0.15 = 涨 15%） */
  return24h: number;
  /** 按小时重采样的近期价格序列，末位是最新。少于 48 点时按现有长度算回撤 */
  hourlyPrices: number[];
}

export interface ISellV2Result {
  action: ISellV2Action;
  /** 触发时的说明，落库备查——评估假信号率时要能看出当时是凭什么判的 */
  reason: string;
  drawdown48h: number;
}

/** 近 48 小时最高价到当前价的回撤幅度。序列为空或最高价 ≤0 时返回 0。 */
function drawdownFromPeak(hourlyPrices: number[]): number {
  if (!hourlyPrices.length) return 0;
  const window = hourlyPrices.slice(-DRAWDOWN_WINDOW_HOURS);
  const peak = Math.max(...window);
  const current = window[window.length - 1];
  return peak > 0 ? (peak - current) / peak : 0;
}

/**
 * 影子卖出规则。阈值依据见文件头的回测表——改动任何一个数字之前先重跑
 * `scripts/build-sell-rule-baseline.mjs`，不要凭手感调。
 */
export function evaluateSellV2(input: ISellV2Input): ISellV2Result {
  const drawdown48h = drawdownFromPeak(input.hourlyPrices);
  const pct = (input.return24h * 100).toFixed(1);

  if (drawdown48h > WASHOUT_DRAWDOWN && input.return24h < WASHOUT_VETO_MAX_RETURN) {
    return {
      action: "HOLD",
      reason: `48h 回撤 ${(drawdown48h * 100).toFixed(1)}% 且 24h 涨幅仅 ${pct}%，处于洗盘形态——回测里这种状态未来 7 天超额收益是正的（+2%~+3.7%），不卖`,
      drawdown48h,
    };
  }

  if (input.return24h >= SELL_STRONG_RETURN) {
    return {
      action: "SELL_STRONG",
      reason: `24h 涨幅 ${pct}%，回测里这一档未来 7 天超额收益中位数 -18.69%、71.4% 为负`,
      drawdown48h,
    };
  }

  if (input.return24h >= SELL_NORMAL_RETURN) {
    return {
      action: "SELL",
      reason: `24h 涨幅 ${pct}%，回测里这一档未来 7 天超额收益中位数 -4.35%~-5.89%`,
      drawdown48h,
    };
  }

  return {
    action: "HOLD",
    reason: `24h 涨幅 ${pct}%，没到 15% 的卖出档（5~15% 档超额只有 -3% 上下，扣手续费后不值得换手）`,
    drawdown48h,
  };
}
