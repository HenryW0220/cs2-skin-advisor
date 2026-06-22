"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function EditableBuyPrice({ itemId, value }: { itemId: number; value: number }) {
  const router = useRouter();
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);

  async function save() {
    const parsed = Number(draft);
    if (Number.isNaN(parsed) || parsed === value) return;
    setSaving(true);
    try {
      await fetch(`/api/inventory/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buy_price: parsed }),
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
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className="w-20 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-right text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none disabled:opacity-50"
    />
  );
}
