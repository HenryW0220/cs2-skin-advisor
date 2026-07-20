"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SELL_FEE_PRESETS, type ISellFeeKey } from "@/lib/fees";

// 卖出价待补的记录：填平台成交价 + 选平台，入账自动扣掉该平台的交易手续费
export function EditableSellPrice({ saleId }: { saleId: number }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [feeKey, setFeeKey] = useState<ISellFeeKey>("c5");
  const [saving, setSaving] = useState(false);

  async function save() {
    const parsed = Number(draft);
    if (draft === "" || Number.isNaN(parsed)) return;
    setSaving(true);
    try {
      await fetch(`/api/sales/${saleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sell_price: parsed, fee_key: feeKey }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        value={feeKey}
        onChange={(e) => setFeeKey(e.target.value as ISellFeeKey)}
        className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-xs text-neutral-300"
      >
        {SELL_FEE_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
            {p.rate > 0 ? `（${(p.rate * 100).toFixed(1).replace(/\.0$/, "")}%）` : ""}
          </option>
        ))}
      </select>
      <input
        type="number"
        step="0.01"
        value={draft}
        disabled={saving}
        placeholder="成交价"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-20 rounded border border-orange-800/60 bg-neutral-800 px-2 py-1 text-right text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-orange-500 focus:outline-none disabled:opacity-50"
      />
    </span>
  );
}
