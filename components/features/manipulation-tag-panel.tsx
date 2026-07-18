"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IManipulationConfidence, IManipulationTag } from "@/lib/types";

const CONFIDENCE_LABEL: Record<IManipulationConfidence, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const CONFIDENCE_STYLE: Record<IManipulationConfidence, string> = {
  high: "bg-red-500/15 text-red-400",
  medium: "bg-orange-500/15 text-orange-400",
  low: "bg-neutral-500/15 text-neutral-400",
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// 标记"这个饰品在某段时间被人操盘"，精确到时间窗口而不是只标品本身——
// 只有带时间窗口的标记才能跟对应时段的价格数据配对成训练用的正样本，
// 见 db/migrations/006_add_manipulation_tags.sql 的注释。
export function ManipulationTagPanel({
  itemName,
  initialTags,
}: {
  itemName: string;
  initialTags: IManipulationTag[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState(initialTags);
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState("");
  const [confidence, setConfidence] = useState<IManipulationConfidence>("medium");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function addTag() {
    setSaving(true);
    try {
      const res = await fetch("/api/manipulation-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_name: itemName,
          start_date: startDate,
          end_date: endDate || null,
          confidence,
          note: note || null,
        }),
      });
      const json = (await res.json()) as { data: IManipulationTag | null };
      if (json.data) {
        setTags((prev) => [json.data!, ...prev]);
        setEndDate("");
        setNote("");
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function removeTag(id: number) {
    setTags((prev) => prev.filter((t) => t.id !== id));
    await fetch(`/api/manipulation-tags/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="max-w-[220px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-orange-400 hover:underline"
      >
        操盘标记{tags.length > 0 ? ` (${tags.length})` : ""}
      </button>

      {!open && tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {tags.slice(0, 2).map((t) => (
            <span
              key={t.id}
              className={`rounded px-1.5 py-0.5 text-xs ${CONFIDENCE_STYLE[t.confidence]}`}
            >
              {t.start_date}~{t.end_date ?? "?"}
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="mt-1 space-y-2 rounded border border-neutral-700 bg-neutral-900 p-2">
          {tags.map((t) => (
            <div key={t.id} className="flex items-start justify-between gap-1 text-xs">
              <div>
                <span className={`rounded px-1.5 py-0.5 ${CONFIDENCE_STYLE[t.confidence]}`}>
                  {CONFIDENCE_LABEL[t.confidence]}
                </span>{" "}
                <span className="text-neutral-300">
                  {t.start_date} ~ {t.end_date ?? "进行中"}
                </span>
                {t.note && <div className="text-neutral-500">{t.note}</div>}
              </div>
              <button
                type="button"
                onClick={() => removeTag(t.id)}
                className="shrink-0 text-neutral-500 hover:text-red-400"
              >
                ✕
              </button>
            </div>
          ))}

          <div className="space-y-1.5 border-t border-neutral-800 pt-2">
            <div className="flex gap-1">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-xs text-neutral-100"
              />
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                placeholder="结束（可留空）"
                className="w-full rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-xs text-neutral-100"
              />
            </div>
            <select
              value={confidence}
              onChange={(e) => setConfidence(e.target.value as IManipulationConfidence)}
              className="w-full rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-xs text-neutral-100"
            >
              <option value="high">消息可靠度：高</option>
              <option value="medium">消息可靠度：中</option>
              <option value="low">消息可靠度：低</option>
            </select>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="依据/消息来源，几个月后回看还能懂"
              rows={2}
              className="w-full rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-xs text-neutral-100 placeholder:text-neutral-600"
            />
            <button
              type="button"
              onClick={addTag}
              disabled={saving || !startDate}
              className="w-full rounded border border-orange-800 bg-orange-500/10 px-2 py-1 text-xs text-orange-400 hover:bg-orange-500/20 disabled:opacity-50"
            >
              {saving ? "保存中…" : "添加标记"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
