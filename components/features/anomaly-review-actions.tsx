"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IManipulationConfidence } from "@/lib/types";

// 三分类审核：确认操盘（正样本）/ 外部事件（版本更新等，困难负样本，必须写明是什么
// 事件）/ 正常波动（普通负样本）。同一波行情会在一个饰品上打出多条异常，勾选
// "该饰品待审核事件一并处理"就不用一条条点。
export function AnomalyReviewActions({
  eventId,
  pendingCountForItem,
}: {
  eventId: number;
  pendingCountForItem: number;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "confirming" | "external">("idle");
  const [confidence, setConfidence] = useState<IManipulationConfidence>("medium");
  const [endDate, setEndDate] = useState("");
  const [note, setNote] = useState("");
  const [applyToItem, setApplyToItem] = useState(true);
  const [saving, setSaving] = useState(false);

  const scope = applyToItem ? "item" : "single";

  async function confirm() {
    setSaving(true);
    try {
      await fetch(`/api/anomaly-events/${eventId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confidence,
          end_date: endDate || null,
          note: note || undefined,
          scope,
        }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function dismiss(category: "noise" | "external") {
    setSaving(true);
    try {
      await fetch(`/api/anomaly-events/${eventId}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, note: note || null, scope }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (mode === "idle") {
    return (
      <div className="flex shrink-0 items-center gap-2">
        {pendingCountForItem > 1 && (
          <label className="flex cursor-pointer items-center gap-1 text-xs text-neutral-500">
            <input
              type="checkbox"
              checked={applyToItem}
              onChange={(e) => setApplyToItem(e.target.checked)}
              className="accent-blue-500"
            />
            该饰品 {pendingCountForItem} 条一并处理
          </label>
        )}
        <button
          type="button"
          onClick={() => setMode("confirming")}
          className="rounded border border-red-800 bg-red-500/10 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/20"
        >
          确认是操盘
        </button>
        <button
          type="button"
          onClick={() => setMode("external")}
          className="rounded border border-blue-800 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-500/20"
        >
          外部事件
        </button>
        <button
          type="button"
          onClick={() => dismiss("noise")}
          disabled={saving}
          className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-50"
        >
          正常波动
        </button>
      </div>
    );
  }

  if (mode === "external") {
    return (
      <div className="w-60 shrink-0 space-y-1.5 rounded border border-neutral-700 bg-neutral-900 p-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="是什么事件？如：武库开放炼金、箱子停产、Major 开赛"
          rows={2}
          className="w-full rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-xs text-neutral-100 placeholder:text-neutral-600"
        />
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => dismiss("external")}
            disabled={saving || !note.trim()}
            className="flex-1 rounded border border-blue-800 bg-blue-500/10 px-2 py-1 text-xs text-blue-400 hover:bg-blue-500/20 disabled:opacity-50"
          >
            {saving ? "保存中…" : "记为外部事件"}
          </button>
          <button
            type="button"
            onClick={() => setMode("idle")}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-60 shrink-0 space-y-1.5 rounded border border-neutral-700 bg-neutral-900 p-2">
      <select
        value={confidence}
        onChange={(e) => setConfidence(e.target.value as IManipulationConfidence)}
        className="w-full rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-xs text-neutral-100"
      >
        <option value="high">消息可靠度：高</option>
        <option value="medium">消息可靠度：中</option>
        <option value="low">消息可靠度：低</option>
      </select>
      <input
        type="date"
        value={endDate}
        onChange={(e) => setEndDate(e.target.value)}
        className="w-full rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-xs text-neutral-100"
      />
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="补充依据（可留空，默认写自动检测来源）"
        rows={2}
        className="w-full rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-xs text-neutral-100 placeholder:text-neutral-600"
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={confirm}
          disabled={saving}
          className="flex-1 rounded border border-red-800 bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
        >
          {saving ? "保存中…" : "确认生成标记"}
        </button>
        <button
          type="button"
          onClick={() => setMode("idle")}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
        >
          取消
        </button>
      </div>
    </div>
  );
}
