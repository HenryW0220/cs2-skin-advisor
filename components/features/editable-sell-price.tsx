"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// 卖出价待补的记录（C5 卖单没匹配上的），在流水页直接填
export function EditableSellPrice({ saleId, value }: { saleId: number; value: number | null }) {
  const router = useRouter();
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [saving, setSaving] = useState(false);

  async function save() {
    const parsed = Number(draft);
    if (draft === "" || Number.isNaN(parsed) || parsed === value) return;
    setSaving(true);
    try {
      await fetch(`/api/sales/${saleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sell_price: parsed }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      type="number"
      step="0.01"
      value={draft}
      disabled={saving}
      placeholder="填卖价"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className="w-20 rounded border border-orange-800/60 bg-neutral-800 px-2 py-1 text-right text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-orange-500 focus:outline-none disabled:opacity-50"
    />
  );
}
