"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// 观察池不需要从 Steam 导库存，只需要重新拉一次价格快照。
export function RefreshPricesButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      await fetch("/api/sync", { method: "POST" });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={refresh}
      disabled={loading}
      className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
    >
      {loading ? "刷新中…" : "刷新价格"}
    </button>
  );
}
