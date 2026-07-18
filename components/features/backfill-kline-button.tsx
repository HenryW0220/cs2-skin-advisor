"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IKlineBackfillSummary } from "@/lib/kline-backfill";

// 把持仓饰品最近 90 天的小时级 K 线一次性灌进 price_snapshots，补全手动同步攒不出来的
// 历史密度。kline 是滚动窗口，正常情况偶尔点一次就够，不需要每天跑。
export function BackfillKlineButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/inventory/backfill-kline", { method: "POST" });
      const json = (await res.json()) as { data: IKlineBackfillSummary | null; error?: string };
      if (json.data) {
        const { itemCount, snapshotCount, skippedNoPlatform, errors } = json.data;
        setResult(
          `${itemCount} 个饰品，写入 ${snapshotCount} 条快照` +
            (skippedNoPlatform > 0 ? `，${skippedNoPlatform} 个还没有价格数据跳过` : "") +
            (errors.length > 0 ? `，${errors.length} 个出错` : "")
        );
      } else {
        setResult(json.error ?? "回填失败");
      }
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
      >
        {loading ? "回填中…" : "回填90天K线"}
      </button>
      {result && <span className="text-xs text-neutral-500">{result}</span>}
    </div>
  );
}
