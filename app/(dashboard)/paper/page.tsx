import { STEAM_ICON_BASE_URL } from "@/lib/api/steam";
import { listPaperTrades } from "@/lib/db/paper-trades";
import { listWatchlist } from "@/lib/db/watchlist";
import { getLatestPricesByPlatform } from "@/lib/db/snapshots";
import { netSellPrice } from "@/lib/fees";
import type { IPaperTrade } from "@/lib/types";

export const dynamic = "force-dynamic";

function formatMoney(value: number): string {
  return value.toFixed(2);
}

function formatSigned(value: number, suffix = ""): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function pnlColor(value: number): string {
  return value >= 0 ? "text-red-400" : "text-emerald-400";
}

function daysBetween(fromIso: string, toMs: number): number {
  return Math.floor((toMs - new Date(fromIso).getTime()) / (24 * 60 * 60 * 1000));
}

function parseReasons(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const T7_LOCK_DAYS = 7;

export default function PaperTradingPage() {
  const now = Date.now();
  const trades = listPaperTrades();
  const open = trades.filter((t) => t.status === "open");
  const closedTrades = trades.filter((t) => t.status === "closed");

  // 中文名/图标观察池里有现成的，模拟盘表不重复存
  const displayByName = new Map(
    listWatchlist().map((w) => [w.item_name, { nameCn: w.name_cn, iconUrl: w.icon_url }])
  );

  // 未平仓的按当前参考平台价估值（同样扣一次卖出手续费，跟平仓口径一致）
  const openRows = open.map((t) => {
    const latest = getLatestPricesByPlatform(t.item_name).find((p) => p.platform === t.platform);
    const currentPrice = latest?.price ?? null;
    const unrealized =
      currentPrice !== null ? netSellPrice(currentPrice, "c5").net - t.buy_price : null;
    const heldDays = daysBetween(t.opened_at, now);
    return { trade: t, currentPrice, unrealized, heldDays, locked: heldDays < T7_LOCK_DAYS };
  });

  const closedProfits = closedTrades.map((t) => (t.sell_net_price ?? 0) - t.buy_price);
  const wins = closedProfits.filter((p) => p > 0).length;
  const totalRealized = closedProfits.reduce((sum, p) => sum + p, 0);
  const avgReturnPercent =
    closedTrades.length > 0
      ? (closedTrades.reduce(
          (sum, t) => sum + ((t.sell_net_price ?? 0) - t.buy_price) / t.buy_price,
          0
        ) /
          closedTrades.length) *
        100
      : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">模拟盘</h1>
        <p className="mt-1 text-sm text-neutral-500">
          观察池饰品买入信号（score≥30）自动模拟开仓，T+7 锁定期后出卖出信号或持有满 30
          天平仓，卖出扣 C5 1% 手续费。用来在真实时间线上验证规则引擎的信号有没有用——
          卖出按当前在售价算，偏乐观，真实挂单可能要压价才能成交。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <p className="text-xs text-neutral-500">持仓中 / 已平仓</p>
          <p className="mt-1 text-lg font-semibold">
            {open.length} / {closedTrades.length}
          </p>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <p className="text-xs text-neutral-500">已平仓胜率</p>
          <p className="mt-1 text-lg font-semibold">
            {closedTrades.length > 0
              ? `${((wins / closedTrades.length) * 100).toFixed(0)}%（${wins}/${closedTrades.length}）`
              : "—"}
          </p>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <p className="text-xs text-neutral-500">已实现盈亏（元/件）</p>
          <p
            className={`mt-1 text-lg font-semibold ${closedTrades.length > 0 ? pnlColor(totalRealized) : ""}`}
          >
            {closedTrades.length > 0 ? formatSigned(totalRealized) : "—"}
          </p>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <p className="text-xs text-neutral-500">平均单笔收益率</p>
          <p
            className={`mt-1 text-lg font-semibold ${avgReturnPercent !== null ? pnlColor(avgReturnPercent) : ""}`}
          >
            {avgReturnPercent !== null ? formatSigned(avgReturnPercent, "%") : "—"}
          </p>
        </div>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-300">持仓中（{open.length}）</h2>
        {openRows.length === 0 ? (
          <p className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-500">
            还没有开仓记录。观察池里有饰品的买入信号 score 达到 30 时会自动开仓（每小时同步后判断一次）。
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-neutral-900 text-xs text-neutral-500">
                <tr>
                  <th className="px-4 py-3 text-left">饰品</th>
                  <th className="px-4 py-3 text-right">买入价</th>
                  <th className="px-4 py-3 text-right">现价</th>
                  <th className="px-4 py-3 text-right">浮动盈亏</th>
                  <th className="px-4 py-3 text-center">持有天数</th>
                  <th className="px-4 py-3 text-center">状态</th>
                  <th className="px-4 py-3 text-left">开仓依据</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                {openRows.map(({ trade, currentPrice, unrealized, heldDays, locked }) => {
                  const display = displayByName.get(trade.item_name);
                  return (
                    <tr key={trade.id}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {display?.iconUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`${STEAM_ICON_BASE_URL}/${display.iconUrl}`}
                              alt=""
                              className="h-8 w-10 object-contain"
                            />
                          )}
                          <div>
                            <p>{display?.nameCn ?? trade.item_name}</p>
                            <p className="text-xs text-neutral-600">
                              {trade.platform} · {new Date(trade.opened_at).toLocaleDateString("zh-CN")} 开仓
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">¥{formatMoney(trade.buy_price)}</td>
                      <td className="px-4 py-3 text-right">
                        {currentPrice !== null ? `¥${formatMoney(currentPrice)}` : "—"}
                      </td>
                      <td className={`px-4 py-3 text-right ${unrealized !== null ? pnlColor(unrealized) : ""}`}>
                        {unrealized !== null
                          ? `${formatSigned(unrealized)}（${formatSigned((unrealized / trade.buy_price) * 100, "%")}）`
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-center">{heldDays} 天</td>
                      <td className="px-4 py-3 text-center">
                        {locked ? (
                          <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-400">
                            T+7 锁定中
                          </span>
                        ) : (
                          <span className="rounded bg-neutral-500/15 px-2 py-0.5 text-xs text-neutral-300">
                            等卖出信号
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral-500">
                        score {trade.buy_score}：{parseReasons(trade.buy_reasons).join("；")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-300">
          已平仓（{closedTrades.length}）
        </h2>
        {closedTrades.length === 0 ? (
          <p className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-500">
            还没有平仓记录。开仓后至少要过 7 天锁定期才可能平仓。
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-neutral-900 text-xs text-neutral-500">
                <tr>
                  <th className="px-4 py-3 text-left">饰品</th>
                  <th className="px-4 py-3 text-right">买入价</th>
                  <th className="px-4 py-3 text-right">卖出净价</th>
                  <th className="px-4 py-3 text-right">盈亏</th>
                  <th className="px-4 py-3 text-center">持有天数</th>
                  <th className="px-4 py-3 text-center">平仓原因</th>
                  <th className="px-4 py-3 text-left">平仓时信号</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                {closedTrades.map((t: IPaperTrade) => {
                  const display = displayByName.get(t.item_name);
                  const profit = (t.sell_net_price ?? 0) - t.buy_price;
                  const heldDays = t.closed_at ? daysBetween(t.opened_at, new Date(t.closed_at).getTime()) : null;
                  return (
                    <tr key={t.id}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {display?.iconUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`${STEAM_ICON_BASE_URL}/${display.iconUrl}`}
                              alt=""
                              className="h-8 w-10 object-contain"
                            />
                          )}
                          <div>
                            <p>{display?.nameCn ?? t.item_name}</p>
                            <p className="text-xs text-neutral-600">
                              {new Date(t.opened_at).toLocaleDateString("zh-CN")} →{" "}
                              {t.closed_at ? new Date(t.closed_at).toLocaleDateString("zh-CN") : "—"}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">¥{formatMoney(t.buy_price)}</td>
                      <td className="px-4 py-3 text-right">
                        {t.sell_net_price !== null ? `¥${formatMoney(t.sell_net_price)}` : "—"}
                      </td>
                      <td className={`px-4 py-3 text-right ${pnlColor(profit)}`}>
                        {formatSigned(profit)}（{formatSigned((profit / t.buy_price) * 100, "%")}）
                      </td>
                      <td className="px-4 py-3 text-center">{heldDays !== null ? `${heldDays} 天` : "—"}</td>
                      <td className="px-4 py-3 text-center">
                        {t.close_reason === "sell_signal" ? (
                          <span className="rounded bg-blue-500/15 px-2 py-0.5 text-xs text-blue-400">
                            卖出信号
                          </span>
                        ) : (
                          <span className="rounded bg-neutral-500/15 px-2 py-0.5 text-xs text-neutral-400">
                            超时平仓
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral-500">
                        {t.sell_score !== null ? `score ${t.sell_score}：` : ""}
                        {parseReasons(t.sell_reasons).join("；")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
