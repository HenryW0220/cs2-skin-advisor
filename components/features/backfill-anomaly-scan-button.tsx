"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IAnomalyScanSummary } from "@/lib/anomaly-scan";

// 对已回填的完整历史做一次性回溯扫描，把候选异常事件挖出来放进 /anomalies 待审核。
export function BackfillAnomalyScanButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/inventory/backfill-anomaly-scan", { method: "POST" });
      const json = (await res.json()) as { data: IAnomalyScanSummary | null; error?: string };
      if (json.data) {
        setResult(`${json.data.itemsScanned} 个饰品，发现 ${json.data.eventsCreated} 个候选异常`);
      } else {
        setResult(json.error ?? "扫描失败");
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
        {loading ? "扫描中…" : "扫描历史异常"}
      </button>
      {result && <span className="text-xs text-neutral-500">{result}</span>}
    </div>
  );
}
