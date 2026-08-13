// 换手成本线，以及规则引擎每一档信号的**回测超额实测值**。
//
// 为什么单独一个模块：这两组数字此前散落在脚本注释、HYPOTHESES.md 和会话记录里，
// 页面和 LLM 都拿不到，结果是 `/positions` 把一个赚不回手续费的信号照样显示成建议。
// 判断"这一档值不值得为它换手"的口径必须跟着信号一起走，所以放在 lib/rules 里。
//
// ⚠️ 这里的数字只能由回测脚本更新（scripts/build-rsi-trend-baseline.mjs），
// 不要手改。改了要同步 HYPOTHESES.md §2.2。

/**
 * 一次买入 + 卖出的往返成本下界，0.067 = 6.7%。
 * 来源：买卖价差中位 5.72%（REPORT-bidding-depth-features.md 平时档）+ C5 卖出手续费 1%
 * （lib/fees.ts）。提现费 0.9% 是批量行为、不按笔摊，没算进来。
 */
export const ROUND_TRIP_COST_MIN = 0.067;

/**
 * 项目所有者给的换手成本口径，0.12 = 12%。比下界保守，包含实际成交时的滑点和等待成本。
 * 两条线并列是有意的：RSI 各档对两条线都不够，所以不必先争哪条准（见 HYPOTHESES.md §2.2）。
 */
export const ROUND_TRIP_COST_TARGET = 0.12;

export type ISignalKey = "rsi_overbought" | "rsi_oversold";

export interface ISignalEvidence {
  key: ISignalKey;
  label: string;
  /** 落在该档之后**未来 7 天超额收益的中位数**（小数）。超额 = 该样本收益 − 当天全市场中位数 */
  excess7d: number;
  /** 同一口径的日尺度数字。线上算的是小时桶（见踩坑 45），两个都留着是为了区分"概念没用"和"尺度接错了" */
  excess7dDaily: number;
  /** 该档样本里超额为负的占比 */
  negativeShare: number;
  /** 有该档样本的饰品数——符号检验的真实样本量是这个，不是小时样本数 */
  itemsTested: number;
  /** 按饰品的符号检验 p 值 */
  signTestP: number;
}

/**
 * 2026-08-13 用 714 个饰品 / 109 天重跑的结果（scripts/build-rsi-trend-baseline.mjs），
 * 跟 2026-08-03 首次回算（99 天）一致。小时尺度就是线上实际在用的口径。
 *
 * 均线趋势那两档不在这里，因为它们已经从规则引擎删掉了——实测方向是反的
 * （配对检验 587/713 个饰品走弱之后反而更好，p=0.0000）。
 */
export const SIGNAL_EVIDENCE: Record<ISignalKey, ISignalEvidence> = {
  rsi_overbought: {
    key: "rsi_overbought",
    label: "RSI 超买",
    excess7d: -0.0096,
    excess7dDaily: -0.0357,
    negativeShare: 0.5631,
    itemsTested: 701,
    signTestP: 0.0001,
  },
  rsi_oversold: {
    key: "rsi_oversold",
    label: "RSI 超卖",
    excess7d: 0.0061,
    excess7dDaily: 0.0037,
    negativeShare: 0.4548,
    itemsTested: 698,
    signTestP: 0.0001,
  },
};

/**
 * 这一档的历史超额幅度够不够覆盖一次换手的成本。
 * 用下界（6.7%）判定——连下界都够不着的，按哪条口径都不值得动手。
 *
 * 注意判的是**绝对值**：卖出侧信号的超额是负的，"够得着"指的是幅度够大，
 * 方向由信号自己表达。
 */
export function isActionable(evidence: ISignalEvidence): boolean {
  return Math.abs(evidence.excess7d) >= ROUND_TRIP_COST_MIN;
}

/** 给页面和 LLM 用的一句话：这一档历史上值多少、跟成本线差多少。 */
export function describeEvidence(evidence: ISignalEvidence): string {
  const excess = (evidence.excess7d * 100).toFixed(2);
  const cost = (ROUND_TRIP_COST_MIN * 100).toFixed(1);
  return isActionable(evidence)
    ? `${evidence.label}：历史未来 7 天超额中位 ${excess}%，够得着 ${cost}% 的往返成本`
    : `${evidence.label}：历史未来 7 天超额中位 ${excess}%，低于 ${cost}% 的往返成本，不可行动`;
}

/** 一组信号里只要有一档够得着成本线，这条建议就算可行动。全都够不着时页面要显式标出来。 */
export function hasActionableSignal(keys: ISignalKey[]): boolean {
  return keys.some((key) => isActionable(SIGNAL_EVIDENCE[key]));
}

/**
 * 从 score 反推触发的是哪一档。
 *
 * 页面读的是 `item_signal_summaries` 预计算表，那张表只存 action/score 不存 signalKeys，
 * 而补一列要动迁移和写入路径、收益只有省掉这个映射——**成立的前提是"规则引擎只剩 RSI
 * 单因子"**，所以 evaluate.test.ts 里有一条测试把这个映射和 `evaluateSignals` 的真实
 * 输出对齐：哪天再加一项，那条测试会先失败。
 */
export function evidenceForScore(score: number | null): ISignalEvidence | null {
  if (score === null) return null;
  if (score <= -30) return SIGNAL_EVIDENCE.rsi_overbought;
  if (score >= 30) return SIGNAL_EVIDENCE.rsi_oversold;
  return null;
}
