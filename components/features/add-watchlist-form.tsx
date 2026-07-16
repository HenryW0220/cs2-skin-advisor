"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { STEAM_ICON_BASE_URL } from "@/lib/api/steam";

interface ISearchItem {
  marketHashName: string;
  nameCn: string;
  iconUrl: string;
}

// 中文/英文都能搜，本质是代理 Steam 市场的模糊搜索接口——用户从下拉列表里选一条，
// 提交的就是真实的 market_hash_name，不会再出现名字打错或磨损度不存在的情况。
// 如果用户不选，直接手打回车提交，也保留原来"按原样当 market_hash_name 提交"的行为。
export function AddWatchlistForm() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ISearchItem | null>(null);
  const [results, setResults] = useState<ISearchItem[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [targetBuyPrice, setTargetBuyPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || selected) return;

    const seq = ++requestSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/items/search?q=${encodeURIComponent(trimmed)}`);
        const json = await res.json();
        if (seq === requestSeq.current) {
          setResults(json.data ?? []);
          setShowResults(true);
        }
      } catch {
        if (seq === requestSeq.current) setResults([]);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, selected]);

  function pickResult(item: ISearchItem) {
    setSelected(item);
    setQuery(item.nameCn);
    setShowResults(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const itemName = selected?.marketHashName ?? query.trim();
    if (!itemName) return;

    setSaving(true);
    setError(null);
    setWarning(null);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_name: itemName,
          target_buy_price: targetBuyPrice ? Number(targetBuyPrice) : null,
        }),
      });
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        return;
      }
      if (json.warning) {
        setWarning(json.warning);
      }
      setQuery("");
      setSelected(null);
      setResults([]);
      setTargetBuyPrice("");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1">
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <div className="relative w-80">
          <input
            type="text"
            value={query}
            onChange={(e) => {
              const value = e.target.value;
              setQuery(value);
              setSelected(null);
              if (!value.trim()) {
                setResults([]);
                setShowResults(false);
              }
            }}
            onFocus={() => results.length > 0 && setShowResults(true)}
            onBlur={() => setTimeout(() => setShowResults(false), 150)}
            placeholder="搜索饰品（中文或英文都行，比如 红线 / Redline）"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          {showResults && results.length > 0 && (
            <ul className="absolute z-10 mt-1 max-h-80 w-full overflow-y-auto rounded border border-neutral-700 bg-neutral-900 shadow-lg">
              {results.map((item) => (
                <li key={item.marketHashName}>
                  <button
                    type="button"
                    onClick={() => pickResult(item)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-800"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- 外部 Steam CDN 图片，没配 next/image 的 remotePatterns */}
                    <img
                      src={`${STEAM_ICON_BASE_URL}/${item.iconUrl}`}
                      alt={item.nameCn}
                      width={28}
                      height={28}
                      className="size-7 shrink-0 rounded bg-neutral-800 object-contain"
                    />
                    <span className="min-w-0 truncate">{item.nameCn}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <input
          type="number"
          step="0.01"
          value={targetBuyPrice}
          onChange={(e) => setTargetBuyPrice(e.target.value)}
          placeholder="目标买入价（可选）"
          className="w-36 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={saving || !(selected?.marketHashName ?? query.trim())}
          className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {saving ? "添加中…" : "加入观察池"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </form>
      {warning && <p className="text-xs text-amber-400">{warning}</p>}
    </div>
  );
}
