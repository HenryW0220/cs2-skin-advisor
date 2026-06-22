"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// 点一下同时做两件事：从 Steam 拉新饰品（不会动已经改过的购入价），再批量同步最新价格。
export function RefreshInventoryButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      await fetch("/api/inventory/import-steam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
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
      {loading ? "刷新中…" : "刷新库存"}
    </button>
  );
}
