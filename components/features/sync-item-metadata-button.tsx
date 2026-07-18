"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IItemMetadataSyncSummary } from "@/lib/item-metadata-sync";

// 从 ByMykel/CSGO-API 拉持仓+观察池饰品的收藏品/品质资料。数据集是静态的，
// 加了新持仓或出了新箱子后手动点一次即可，不需要定时跑。
export function SyncItemMetadataButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/item-metadata/sync", { method: "POST" });
      const json = (await res.json()) as { data: IItemMetadataSyncSummary | null; error?: string };
      if (json.data) {
        setResult(
          `${json.data.itemCount} 个饰品，匹配到 ${json.data.matched} 个` +
            (json.data.unmatched > 0 ? `（${json.data.unmatched} 个是印花/非皮肤，正常）` : "")
        );
      } else {
        setResult(json.error ?? "同步失败");
      }
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
      >
        {loading ? "同步中…" : "同步收藏品资料"}
      </button>
      {result && <span className="text-xs text-neutral-500">{result}</span>}
    </div>
  );
}
