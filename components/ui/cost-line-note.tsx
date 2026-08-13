import {
  ROUND_TRIP_COST_MIN,
  ROUND_TRIP_COST_TARGET,
  evidenceForScore,
  isActionable,
} from "@/lib/rules/cost-line";

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

/**
 * 把"这一档历史上值多少、够不够一次换手的成本"直接标在建议旁边。
 *
 * 为什么要有这个组件：规则引擎剩下的 RSI 两档回测超额只有零点几个百分点，而一次往返
 * 成本 6.7%~12%。不标出来的话，页面上「建议减持」和一个够得着成本线的信号长得一模一样，
 * 而它们的含义差一个数量级。
 *
 * @param variant compact 用在持仓表格里（一行放得下），full 用在饰品详情页
 */
export function CostLineNote({
  score,
  variant = "compact",
}: {
  score: number | null;
  variant?: "compact" | "full";
}) {
  const evidence = evidenceForScore(score);
  if (!evidence) return null;

  const actionable = isActionable(evidence);
  const excess = formatPercent(evidence.excess7d);
  const costMin = `${(ROUND_TRIP_COST_MIN * 100).toFixed(1)}%`;
  const costTarget = `${(ROUND_TRIP_COST_TARGET * 100).toFixed(0)}%`;

  if (actionable) {
    return (
      <span className="text-xs text-neutral-400">
        历史超额 {excess}（≥ {costMin} 成本线）
      </span>
    );
  }

  if (variant === "compact") {
    return (
      <span
        className="mt-1 block text-[11px] leading-tight text-neutral-500"
        title={`${evidence.label}档：未来 7 天超额收益中位 ${excess}，一次往返成本 ${costMin}~${costTarget}，赚不回换手成本。样本 ${evidence.itemsTested} 个饰品，符号检验 p<0.001。`}
      >
        不可行动 · 历史超额 {excess}
      </span>
    );
  }

  return (
    <p className="text-xs leading-relaxed text-neutral-500">
      <span className="text-orange-400/80">不可行动</span>：{evidence.label}档历史上未来 7 天的
      超额收益中位数只有 {excess}，而一次买卖往返成本是 {costMin}~{costTarget}——方向没错，
      但幅度差一个数量级，赚不回换手成本。（{evidence.itemsTested} 个饰品，符号检验 p&lt;0.001，
      口径见 scripts/build-rsi-trend-baseline.mjs）
    </p>
  );
}
