"use client";

import { useState } from "react";

interface ISignalsResponse {
  data: {
    reason: { reason: string | null; error?: string } | null;
  } | null;
  error?: string;
}

// 点击才调用 LLM，不在页面加载时对每一行自动触发——持仓多的话一次性调几十次 LLM
// 又慢又浪费额度，缓存只能避免重复调用，避免不了"同时发起一大堆请求"这个问题。
export function AiInsight({
  itemName,
  platform,
  holding = true,
}: {
  itemName: string;
  platform: string;
  holding?: boolean; // 观察池里的饰品传 false，规则引擎才会按"买入时机"而不是"卖出信号"给理由
}) {
  const [state, setState] = useState<"idle" | "loading" | "open">("idle");
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (state === "open") {
      setState("idle");
      return;
    }
    if (reason || error) {
      setState("open");
      return;
    }

    setState("loading");
    try {
      const res = await fetch(
        `/api/signals?itemName=${encodeURIComponent(itemName)}&platform=${encodeURIComponent(platform)}&holding=${holding}&withReason=true`
      );
      const json = (await res.json()) as ISignalsResponse;
      const reasonResult = json.data?.reason;
      if (reasonResult?.reason) {
        setReason(reasonResult.reason);
      } else {
        setError(reasonResult?.error ?? json.error ?? "暂时拿不到 AI 建议");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setState("open");
    }
  }

  return (
    <div className="max-w-xs">
      <button
        type="button"
        onClick={handleClick}
        className="text-xs text-blue-400 hover:underline"
      >
        {state === "loading" ? "AI 思考中…" : state === "open" ? "收起" : "AI 建议"}
      </button>
      {state === "open" && (
        <p className={`mt-1 text-xs ${error ? "text-red-400" : "text-neutral-400"}`}>
          {error ?? reason}
        </p>
      )}
    </div>
  );
}
