"use client";

import { useState } from "react";
import type { IItemCatalogSyncSummary } from "@/lib/item-catalog-sync";

// 从 ByMykel/CSGO-API 全量刷新本地饰品目录（"加入观察池"的联想搜索查的就是这张表）。
// 数据集是静态的，新箱子/新探员发布后手动点一次即可，不需要定时跑。
export function SyncItemCatalogButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/item-catalog/sync", { method: "POST" });
      const json = (await res.json()) as { data: IItemCatalogSyncSummary | null; error?: string };
      if (json.data) {
        setResult(`已入库 ${json.data.total} 条（皮肤 ${json.data.skins} / 探员 ${json.data.agents}）`);
      } else {
        setResult(json.error ?? "同步失败");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="self-start rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
      >
        {loading ? "同步中…（数据集约 30MB，要一会儿）" : "同步饰品目录"}
      </button>
      {result && <span className="text-xs text-neutral-500">{result}</span>}
    </div>
  );
}
