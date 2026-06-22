import { listWatchlist } from "@/lib/db/watchlist";
import { getLatestPricesByPlatform } from "@/lib/db/snapshots";
import { computeSignalSummary, pickReferencePlatform } from "@/lib/signal-summary";

// score 的分段是经验值，跟 lib/rules/evaluate.ts 里 SELL/TRIM 的阈值是对称设计的：
// >=30 大致对应"明显超卖/趋势走强"，<0 大致对应"超买/趋势走弱"，中间是中性。
function buyTimingLabel(score: number): { text: string; className: string } {
  if (score >= 30) {
    return { text: "现在是较好的买入时机", className: "bg-emerald-500/15 text-emerald-400" };
  }
  if (score >= 0) {
    return { text: "可以观察，还不是最佳时机", className: "bg-neutral-500/15 text-neutral-300" };
  }
  return { text: "当前偏强势/超买，不建议现在买", className: "bg-red-500/15 text-red-400" };
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

interface IWatchRow {
  id: number;
  itemName: string;
  targetBuyPrice: number | null;
  marketPrice: number | null;
  score: number | null;
  reasons: string[];
}

export default async function WatchlistPage() {
  const watchlist = listWatchlist();

  const rows: IWatchRow[] = watchlist.map((item) => {
    const platform = pickReferencePlatform(item.item_name);
    const latest = platform
      ? getLatestPricesByPlatform(item.item_name).find((p) => p.platform === platform)
      : undefined;
    const summary = platform ? computeSignalSummary(item.item_name, platform, false) : null;

    return {
      id: item.id,
      itemName: item.item_name,
      targetBuyPrice: item.target_buy_price,
      marketPrice: latest?.price ?? null,
      score: summary?.rule.score ?? null,
      reasons: summary?.rule.reasons ?? [],
    };
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-neutral-200">观察池</h1>
      <div className="space-y-3">
        {rows.map((row) => {
          const timing = row.score !== null ? buyTimingLabel(row.score) : null;
          const reachedTarget =
            row.marketPrice !== null && row.targetBuyPrice !== null
              ? row.marketPrice <= row.targetBuyPrice
              : null;
          return (
            <div
              key={row.id}
              className="rounded-lg border border-neutral-800 bg-neutral-900 px-5 py-4"
            >
              <div className="flex items-center justify-between">
                <div className="font-medium">{row.itemName}</div>
                {timing && (
                  <span className={`rounded px-2 py-1 text-xs ${timing.className}`}>
                    {timing.text}
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-6 text-sm text-neutral-400">
                <span>
                  当前价：
                  {row.marketPrice !== null ? `¥${formatMoney(row.marketPrice)}` : "暂无数据"}
                </span>
                {row.targetBuyPrice !== null && (
                  <span>
                    目标买入价：¥{formatMoney(row.targetBuyPrice)}{" "}
                    {reachedTarget !== null && (
                      <span className={reachedTarget ? "text-emerald-400" : "text-neutral-500"}>
                        {reachedTarget ? "（已到价）" : "（还没到）"}
                      </span>
                    )}
                  </span>
                )}
              </div>
              {row.reasons.length > 0 && (
                <ul className="mt-2 list-inside list-disc text-xs text-neutral-500">
                  {row.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-5 py-10 text-center text-neutral-500">
            观察池是空的，先调用 POST /api/watchlist 添加感兴趣的饰品
          </div>
        )}
      </div>
    </div>
  );
}
