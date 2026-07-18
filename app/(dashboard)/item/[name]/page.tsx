import Link from "next/link";
import { AiInsight } from "@/components/features/ai-insight";
import { PriceChart, type IPriceChartPoint } from "@/components/features/price-chart";
import { STEAM_ICON_BASE_URL } from "@/lib/api/steam";
import { findInventoryItemsByName } from "@/lib/db/inventory";
import { getItemMetadata } from "@/lib/db/item-metadata";
import { getLatestPricesByPlatform, getPriceHistory } from "@/lib/db/snapshots";
import { listWatchlist } from "@/lib/db/watchlist";
import { movingAverage } from "@/lib/signals/moving-average";
import { computeSignalSummary, pickReferencePlatform } from "@/lib/signal-summary";
import type { ITradeAction } from "@/lib/rules/evaluate";

const ACTION_LABEL: Record<ITradeAction, string> = {
  SELL: "建议卖出",
  TRIM: "建议减持",
  HOLD: "继续持有",
  WATCH: "观察中",
};

const ACTION_STYLE: Record<ITradeAction, string> = {
  SELL: "bg-red-500/15 text-red-400",
  TRIM: "bg-orange-500/15 text-orange-400",
  HOLD: "bg-neutral-500/15 text-neutral-300",
  WATCH: "bg-blue-500/15 text-blue-400",
};

const RANGES = [
  { key: "7", label: "近7天", days: 7 },
  { key: "30", label: "近30天", days: 30 },
  { key: "all", label: "全部", days: null },
] as const;
type IRangeKey = (typeof RANGES)[number]["key"];

function pnlColor(value: number): string {
  return value >= 0 ? "text-red-400" : "text-emerald-400";
}

function formatSigned(value: number, suffix = ""): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

interface ISearchParams {
  platform?: string;
  range?: string;
}

export default async function ItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<ISearchParams>;
}) {
  const { name } = await params;
  const sp = await searchParams;
  // market_hash_name 里有空格、|、★ 等字符，路由段拿到的是编码后的值
  const itemName = decodeURIComponent(name);

  const inventoryItems = findInventoryItemsByName(itemName);
  const watchlistItem = listWatchlist().find((w) => w.item_name === itemName);
  const metadata = getItemMetadata(itemName);
  const holding = inventoryItems.length > 0;
  const displayInfo =
    inventoryItems.find((i) => i.name_cn || i.icon_url) ?? inventoryItems[0] ?? watchlistItem;
  const nameCn = displayInfo?.name_cn ?? null;
  const iconUrl = displayInfo?.icon_url ?? null;

  const latestByPlatform = getLatestPricesByPlatform(itemName).filter((p) => p.price > 0);
  const availablePlatforms = latestByPlatform.map((p) => p.platform);
  const platform =
    sp.platform && availablePlatforms.includes(sp.platform)
      ? sp.platform
      : pickReferencePlatform(itemName);

  const rangeKey: IRangeKey = RANGES.some((r) => r.key === sp.range)
    ? (sp.range as IRangeKey)
    : "30";
  const range = RANGES.find((r) => r.key === rangeKey)!;

  const summary = platform ? computeSignalSummary(itemName, platform, holding) : null;

  // MA 要用窗口之前的快照才算得出来，所以先对全量历史算 MA，再裁剪到展示区间
  const fullHistory = platform ? getPriceHistory(itemName, platform) : [];
  const prices = fullHistory.map((h) => h.price);
  const ma7 = movingAverage(prices, 7);
  const ma30 = movingAverage(prices, 30);
  const cutoffMs =
    range.days !== null && fullHistory.length > 0
      ? new Date(fullHistory[fullHistory.length - 1].captured_at).getTime() -
        range.days * 24 * 60 * 60 * 1000
      : null;
  const chartPoints: IPriceChartPoint[] = fullHistory
    .map((h, i) => ({
      t: h.captured_at,
      price: h.price,
      ma7: ma7[i],
      ma30: ma30[i],
      volume: h.volume,
    }))
    .filter((p) => cutoffMs === null || new Date(p.t).getTime() >= cutoffMs);

  const latest = platform
    ? latestByPlatform.find((p) => p.platform === platform)
    : undefined;
  const spread = summary?.crossPlatformSpread ?? null;

  function buildHref(next: Partial<ISearchParams>): string {
    const merged = { ...sp, ...next };
    const query = new URLSearchParams();
    if (merged.platform) query.set("platform", merged.platform);
    if (merged.range && merged.range !== "30") query.set("range", merged.range);
    const qs = query.toString();
    return `/item/${encodeURIComponent(itemName)}${qs ? `?${qs}` : ""}`;
  }

  const displayName = nameCn ?? itemName;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-neutral-500">
        <Link href={holding ? "/positions" : "/watchlist"} className="hover:text-neutral-200">
          ← 返回{holding ? "持仓" : "观察池"}
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- 外部 Steam CDN 图片，没配 next/image 的 remotePatterns
            <img
              src={`${STEAM_ICON_BASE_URL}/${iconUrl}`}
              alt={displayName}
              width={64}
              height={64}
              className="size-16 shrink-0 rounded bg-neutral-800 object-contain"
            />
          ) : (
            <div className="size-16 shrink-0 rounded bg-neutral-800" />
          )}
          <div>
            <h1 className="text-xl font-semibold text-neutral-100">{displayName}</h1>
            {nameCn && <p className="mt-0.5 text-sm text-neutral-500">{itemName}</p>}
            <div className="mt-1.5 flex items-center gap-2 text-xs text-neutral-500">
              {holding && (
                <span className="rounded bg-neutral-800 px-1.5 py-0.5">
                  持仓 x{inventoryItems.reduce((sum, i) => sum + i.quantity, 0)}
                </span>
              )}
              {watchlistItem && <span className="rounded bg-neutral-800 px-1.5 py-0.5">观察中</span>}
              {metadata?.collection && (
                <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-purple-300">
                  {metadata.collection}
                  {metadata.rarity ? ` · ${metadata.rarity}` : ""}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="text-right">
          {latest ? (
            <>
              <div
                className="text-2xl font-semibold text-neutral-100"
                title={`数据来源 ${latest.platform}`}
              >
                ¥{latest.price.toFixed(2)}
              </div>
              {summary?.changeToday && (
                <div className={`mt-0.5 text-sm ${pnlColor(summary.changeToday.percent)}`}>
                  {formatSigned(summary.changeToday.absolute)}（
                  {formatSigned(summary.changeToday.percent)}%）24h
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-neutral-500">暂无价格数据</div>
          )}
        </div>
      </div>

      {summary && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-5 py-4">
          <span className={`rounded px-2.5 py-1 text-sm ${ACTION_STYLE[summary.rule.action]}`}>
            {ACTION_LABEL[summary.rule.action]}
          </span>
          <span className="text-sm text-neutral-400" style={{ fontVariantNumeric: "tabular-nums" }}>
            信号分 {summary.rule.score}
          </span>
          {summary.rule.reasons.length > 0 && (
            <span className="text-sm text-neutral-500">{summary.rule.reasons.join("；")}</span>
          )}
          {platform && (
            <span className="ml-auto">
              <AiInsight itemName={itemName} platform={platform} holding={holding} />
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex gap-1 rounded-lg border border-neutral-800 p-1 text-xs">
          {RANGES.map((r) => (
            <Link
              key={r.key}
              href={buildHref({ range: r.key })}
              className={`rounded px-2.5 py-1 ${rangeKey === r.key ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
            >
              {r.label}
            </Link>
          ))}
        </div>
        {availablePlatforms.length > 1 && (
          <div className="flex gap-1 rounded-lg border border-neutral-800 p-1 text-xs">
            {availablePlatforms.map((p) => (
              <Link
                key={p}
                href={buildHref({ platform: p })}
                className={`rounded px-2.5 py-1 ${platform === p ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
              >
                {p}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
        {chartPoints.length >= 2 ? (
          <PriceChart points={chartPoints} />
        ) : (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-neutral-500">
            <p>这个区间还没有足够的价格快照</p>
            <p className="text-xs">在持仓或观察池页面点“刷新价格”同步几次后就有走势了</p>
          </div>
        )}
      </div>

      {summary?.manipulation && (
        <div
          className={`rounded-lg border px-5 py-3 text-sm ${
            summary.manipulation.level === "high"
              ? "border-red-900/60 bg-red-500/5 text-red-300"
              : summary.manipulation.level === "medium"
                ? "border-orange-900/60 bg-orange-500/5 text-orange-300"
                : "border-neutral-800 bg-neutral-900 text-neutral-400"
          }`}
        >
          <span className="font-medium">
            操盘嫌疑分 {summary.manipulation.score}
            {summary.manipulation.level === "high"
              ? "（高——当前波动形态跟已确认的操盘期高度相似）"
              : summary.manipulation.level === "medium"
                ? "（中——有异动，值得盯一下）"
                : "（低——当前走势平稳）"}
          </span>
          <span className="ml-3 text-xs opacity-70">
            24h波动率 {(summary.manipulation.volatility24h * 100).toFixed(2)}% · 24h涨跌{" "}
            {(summary.manipulation.move24h * 100).toFixed(1)}% · 偏离周线均值{" "}
            {(summary.manipulation.maDeviation * 100).toFixed(1)}%
          </span>
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <SignalCard
            label="MA7"
            value={summary.signals.ma7 !== null ? `¥${summary.signals.ma7.toFixed(2)}` : "数据不足"}
          />
          <SignalCard
            label="MA30"
            value={summary.signals.ma30 !== null ? `¥${summary.signals.ma30.toFixed(2)}` : "数据不足"}
          />
          <SignalCard
            label="RSI14"
            value={summary.signals.rsi14 !== null ? summary.signals.rsi14.toFixed(1) : "数据不足"}
            hint={
              summary.signals.rsi14 === null
                ? undefined
                : summary.signals.rsi14 >= 70
                  ? "超买"
                  : summary.signals.rsi14 <= 30
                    ? "超卖"
                    : "中性"
            }
          />
          <SignalCard
            label="成交量异常"
            value={
              summary.signals.volumeAnomalyRatio !== null
                ? `${summary.signals.volumeAnomalyRatio.toFixed(1)}x`
                : "无异常"
            }
          />
        </div>
      )}

      {latestByPlatform.length > 0 && (
        <div className="rounded-lg border border-neutral-800">
          <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900 px-4 py-3">
            <h2 className="text-sm font-medium text-neutral-300">各平台最新报价</h2>
            {spread && (
              <span className="text-xs text-neutral-500">
                价差 ¥{spread.spread.toFixed(2)}（{(spread.spreadPercent * 100).toFixed(1)}%），
                {spread.cheapest.platform} 最低 / {spread.mostExpensive.platform} 最高
              </span>
            )}
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-neutral-800">
              {[...latestByPlatform]
                .sort((a, b) => a.price - b.price)
                .map((p) => (
                  <tr key={p.platform} className="hover:bg-neutral-900/60">
                    <td className="px-4 py-2.5">
                      <span className={p.platform === platform ? "text-neutral-100" : "text-neutral-400"}>
                        {p.platform}
                      </span>
                      {p.platform === platform && (
                        <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">
                          参考平台
                        </span>
                      )}
                    </td>
                    <td
                      className="px-4 py-2.5 text-right text-neutral-200"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      ¥{p.price.toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-neutral-500">
                      {new Date(p.captured_at).toLocaleString("zh-CN")}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {!platform && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-5 py-8 text-center text-sm text-neutral-500">
          还没有这个饰品的价格数据，先在持仓或观察池页面点“刷新价格”同步一次
        </div>
      )}
    </div>
  );
}

function SignalCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-neutral-100">
        {value}
        {hint && <span className="ml-2 text-xs font-normal text-neutral-500">{hint}</span>}
      </div>
    </div>
  );
}
