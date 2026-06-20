import { generateTradeReason } from "./api/nvidia-llm";
import { getCachedReason, setCachedReason } from "./db/reason-cache";
import type { IRuleResult } from "./rules/evaluate";

function buildCacheKey(itemName: string, action: string, score: number): string {
  const roundedScore = Math.round(score / 5) * 5; // score 小幅波动不重新生成理由
  const today = new Date().toISOString().slice(0, 10); // 每天自然过期一次
  return `${itemName}:${action}:${roundedScore}:${today}`;
}

export interface IReasonResult {
  reason: string | null;
  error?: string;
  fromCache: boolean;
}

// 同一个饰品在同一天、同样的操作建议、差不多的 score（按 5 分一档）下只调一次 LLM。
export async function getOrGenerateReason(
  itemName: string,
  rule: Pick<IRuleResult, "action" | "score" | "reasons">
): Promise<IReasonResult> {
  const cacheKey = buildCacheKey(itemName, rule.action, rule.score);
  const cached = getCachedReason(cacheKey);
  if (cached) {
    return { reason: cached, fromCache: true };
  }

  const result = await generateTradeReason({
    itemName,
    action: rule.action,
    score: rule.score,
    reasons: rule.reasons,
  });

  if (result.error || !result.data) {
    return { reason: null, error: result.error, fromCache: false };
  }

  setCachedReason(cacheKey, itemName, result.data);
  return { reason: result.data, fromCache: false };
}
