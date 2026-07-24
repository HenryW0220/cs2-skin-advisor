"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { STEAM_ICON_BASE_URL } from "@/lib/api/steam";

interface ISuggestItem {
  itemName: string;
  nameCn: string | null;
  iconUrl: string | null;
}

interface IProps {
  items: ISuggestItem[];
  defaultValue?: string;
  lang?: string;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-amber-400">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

// 观察池里饰品一多，光靠"打对完整名字才能过滤"很难找到目标——这里在本地已加载的
// 观察池数据里做联想（不用再发请求），输入时实时列出匹配项并高亮命中的片段，
// 点开某一条直接按精确名字过滤表格，不用非得敲对整个名字再回车。
export function WatchlistSearchBox({ items, defaultValue, lang }: IProps) {
  const router = useRouter();
  const [query, setQuery] = useState(defaultValue ?? "");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const trimmed = query.trim().toLowerCase();
  const suggestions = trimmed
    ? items
        .filter(
          (item) =>
            item.itemName.toLowerCase().includes(trimmed) ||
            (item.nameCn?.toLowerCase().includes(trimmed) ?? false)
        )
        .slice(0, 8)
    : [];

  function navigate(q: string) {
    const params = new URLSearchParams();
    if (lang) params.set("lang", lang);
    if (q) params.set("q", q);
    router.push(`/watchlist?${params.toString()}`);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigate(query.trim());
    setShowSuggestions(false);
  }

  function pickSuggestion(item: ISuggestItem) {
    const display = item.nameCn ?? item.itemName;
    setQuery(display);
    navigate(display);
    setShowSuggestions(false);
  }

  return (
    <form onSubmit={handleSubmit} className="relative w-64">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setShowSuggestions(true);
        }}
        onFocus={() => setShowSuggestions(true)}
        onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
        placeholder="搜索饰品名称（中/英文都行）"
        className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        autoComplete="off"
      />
      {showSuggestions && suggestions.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded border border-neutral-700 bg-neutral-900 shadow-lg">
          {suggestions.map((item) => (
            <li key={item.itemName}>
              <button
                type="button"
                onClick={() => pickSuggestion(item)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-800"
              >
                {item.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 外部 Steam CDN 图片，没配 next/image 的 remotePatterns
                  <img
                    src={`${STEAM_ICON_BASE_URL}/${item.iconUrl}`}
                    alt=""
                    width={24}
                    height={24}
                    className="size-6 shrink-0 rounded bg-neutral-800 object-contain"
                  />
                ) : (
                  <div className="size-6 shrink-0 rounded bg-neutral-800" />
                )}
                <span className="min-w-0 truncate">
                  {highlightMatch(item.nameCn ?? item.itemName, trimmed)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
