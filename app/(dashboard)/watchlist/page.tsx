import Link from "next/link";
import { AddWatchlistForm } from "@/components/features/add-watchlist-form";
import { AiInsight } from "@/components/features/ai-insight";
import { RefreshPricesButton } from "@/components/features/refresh-prices-button";
import { RemoveWatchlistButton } from "@/components/features/remove-watchlist-button";
import { Sparkline } from "@/components/ui/sparkline";
import { STEAM_ICON_BASE_URL } from "@/lib/api/steam";
import { listWatchlist } from "@/lib/db/watchlist";
import { getLatestPricesByPlatform } from "@/lib/db/snapshots";
import { computeSignalSummary, pickReferencePlatform } from "@/lib/signal-summary";

// score 的分段是经验值，跟 lib/rules/evaluate.ts 里 SELL/TRIM 的阈值是对称设计的：
// >=30 大致对应"明显超卖/趋势走强"，<0 大致对应"超买/趋势走弱"，中间是中性。
function buyTimingLabel(score: number): { text: string; className: string } {
  if (score >= 30) {
    return { text: "较好的买入时机", className: "bg-emerald-500/15 text-emerald-400" };
  }
  if (score >= 0) {
    return { text: "可以观察，还不是最佳时机", className: "bg-neutral-500/15 text-neutral-300" };
  }
  return { text: "偏强势/超买，不建议现在买", className: "bg-red-500/15 text-red-400" };
}

function pnlColor(value: number): string {
  return value >= 0 ? "text-red-400" : "text-emerald-400";
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

function formatSigned(value: number, suffix = ""): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

const SORT_KEYS = ["market", "score", "changeToday"] as const;
type ISortKey = (typeof SORT_KEYS)[number];

interface ISearchParams {
  lang?: string;
  q?: string;
  sortBy?: string;
  sortDir?: string;
}

function buildHref(base: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(base)) {
    if (value) params.set(key, value);
  }
  return `/watchlist?${params.toString()}`;
}

interface IWatchRow {
  id: number;
  itemName: string;
  nameCn: string | null;
  iconUrl: string | null;
  targetBuyPrice: number | null;
  targetSellPrice: number | null;
  marketPrice: number | null;
  platform: string | null;
  score: number | null;
  changeTodayPercent: number | null;
  recentPrices: number[];
}

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<ISearchParams>;
}) {
  const sp = await searchParams;
  const showEnglish = sp.lang === "en";
  const query = sp.q?.trim().toLowerCase() ?? "";
  const sortBy = SORT_KEYS.includes(sp.sortBy as ISortKey) ? (sp.sortBy as ISortKey) : undefined;
  const sortDir = sp.sortDir === "asc" ? "asc" : "desc";

  const watchlist = listWatchlist();

  let rows: IWatchRow[] = watchlist.map((item) => {
    const platform = pickReferencePlatform(item.item_name);
    const latest = platform
      ? getLatestPricesByPlatform(item.item_name).find((p) => p.platform === platform)
      : undefined;
    const summary = platform ? computeSignalSummary(item.item_name, platform, false) : null;

    return {
      id: item.id,
      itemName: item.item_name,
      nameCn: item.name_cn,
      iconUrl: item.icon_url,
      targetBuyPrice: item.target_buy_price,
      targetSellPrice: item.target_sell_price,
      marketPrice: latest?.price ?? null,
      platform,
      score: summary?.rule.score ?? null,
      changeTodayPercent: summary?.changeToday?.percent ?? null,
      recentPrices: summary?.recentPrices ?? [],
    };
  });

  if (query) {
    rows = rows.filter(
      (r) =>
        r.itemName.toLowerCase().includes(query) || (r.nameCn?.toLowerCase().includes(query) ?? false)
    );
  }

  if (sortBy) {
    const sortValue = (row: IWatchRow): number => {
      switch (sortBy) {
        case "market":
          return row.marketPrice ?? NaN;
        case "score":
          return row.score ?? NaN;
        case "changeToday":
          return row.changeTodayPercent ?? NaN;
      }
    };
    const withValue = rows.filter((r) => !Number.isNaN(sortValue(r)));
    const withoutValue = rows.filter((r) => Number.isNaN(sortValue(r)));
    withValue.sort((a, b) => (sortValue(a) - sortValue(b)) * (sortDir === "asc" ? 1 : -1));
    rows = [...withValue, ...withoutValue];
  }

  function sortLink(key: ISortKey): string {
    return buildHref({
      ...sp,
      sortBy: key,
      sortDir: sortBy === key && sortDir === "desc" ? "asc" : "desc",
    });
  }

  function sortArrow(key: ISortKey): string {
    if (sortBy !== key) return "";
    return sortDir === "desc" ? " ↓" : " ↑";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-neutral-200">观察池</h1>
        <div className="flex shrink-0 gap-1 rounded-lg border border-neutral-800 p-1 text-xs">
          <Link
            href={buildHref({ ...sp, lang: "zh" })}
            className={`rounded px-2 py-1 ${!showEnglish ? "bg-neutral-800 text-neutral-100" : "text-neutral-500"}`}
          >
            中文
          </Link>
          <Link
            href={buildHref({ ...sp, lang: "en" })}
            className={`rounded px-2 py-1 ${showEnglish ? "bg-neutral-800 text-neutral-100" : "text-neutral-500"}`}
          >
            EN
          </Link>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <AddWatchlistForm />
        <RefreshPricesButton />
      </div>

      <div className="flex items-center justify-between gap-3">
        <form action="/watchlist" method="GET" className="flex items-center gap-2">
          {sp.lang && <input type="hidden" name="lang" value={sp.lang} />}
          <input
            type="text"
            name="q"
            defaultValue={sp.q}
            placeholder="搜索饰品名称（中/英文都行）"
            className="w-64 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </form>
      </div>

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-4 py-3 text-left">饰品</th>
              <th className="px-4 py-3 text-right">
                <Link href={sortLink("market")}>当前价{sortArrow("market")}</Link>
              </th>
              <th className="px-4 py-3 text-right">目标买入价</th>
              <th className="px-4 py-3 text-right">
                <Link href={sortLink("changeToday")}>今日涨跌{sortArrow("changeToday")}</Link>
              </th>
              <th className="px-4 py-3 text-center">近7天走势</th>
              <th className="px-4 py-3 text-center">
                <Link href={sortLink("score")}>买入时机{sortArrow("score")}</Link>
              </th>
              <th className="px-4 py-3 text-left">AI 建议</th>
              <th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.map((row) => {
              const displayName = (showEnglish ? null : row.nameCn) ?? row.itemName;
              const timing = row.score !== null ? buyTimingLabel(row.score) : null;
              const reachedTarget =
                row.marketPrice !== null && row.targetBuyPrice !== null
                  ? row.marketPrice <= row.targetBuyPrice
                  : null;
              return (
                <tr key={row.id} className="hover:bg-neutral-900/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {row.iconUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- 外部 Steam CDN 图片，没配 next/image 的 remotePatterns
                        <img
                          src={`${STEAM_ICON_BASE_URL}/${row.iconUrl}`}
                          alt={displayName}
                          width={40}
                          height={40}
                          className="size-10 shrink-0 rounded bg-neutral-800 object-contain"
                        />
                      ) : (
                        <div className="size-10 shrink-0 rounded bg-neutral-800" />
                      )}
                      <Link
                        href={`/item/${encodeURIComponent(row.itemName)}`}
                        className="font-medium hover:text-blue-400 hover:underline"
                      >
                        {displayName}
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.marketPrice !== null ? `¥${formatMoney(row.marketPrice)}` : "暂无数据"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.targetBuyPrice !== null ? (
                      <span>
                        ¥{formatMoney(row.targetBuyPrice)}{" "}
                        {reachedTarget !== null && (
                          <span className={reachedTarget ? "text-emerald-400" : "text-neutral-500"}>
                            {reachedTarget ? "（已到价）" : "（还没到）"}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-neutral-500">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.changeTodayPercent !== null ? (
                      <span className={pnlColor(row.changeTodayPercent)}>
                        {formatSigned(row.changeTodayPercent)}%
                      </span>
                    ) : (
                      <span className="text-neutral-500">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Sparkline prices={row.recentPrices} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    {timing ? (
                      <span className={`rounded px-2 py-1 text-xs ${timing.className}`}>
                        {timing.text}
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-500">暂无信号</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.platform ? (
                      <AiInsight itemName={row.itemName} platform={row.platform} holding={false} />
                    ) : (
                      <span className="text-xs text-neutral-500">暂无数据</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RemoveWatchlistButton id={row.id} />
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-neutral-500">
                  {watchlist.length === 0
                    ? "观察池是空的，在上面输入饰品全名加进来"
                    : "没有匹配的饰品"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
