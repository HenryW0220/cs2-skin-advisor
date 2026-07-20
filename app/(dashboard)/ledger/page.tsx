import { EditableSellPrice } from "@/components/features/editable-sell-price";
import { STEAM_ICON_BASE_URL } from "@/lib/api/steam";
import { listSaleRecords } from "@/lib/db/sales";
import type { ISaleRecord } from "@/lib/types";

// 没有 searchParams 的页面会被生产构建静态预渲染成死数据，强制按请求渲染
export const dynamic = "force-dynamic";

function pnlColor(value: number): string {
  return value >= 0 ? "text-red-400" : "text-emerald-400";
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

interface IMonthSummary {
  month: string;
  sellTotal: number; // 已知卖价的卖出额
  costTotal: number; // 对应的已知买入成本（买入价>0 且卖价已知）
  profit: number; // Σ(卖-买)，两头都已知才计入
  pendingCount: number;
  records: ISaleRecord[];
}

function groupByMonth(records: ISaleRecord[]): IMonthSummary[] {
  const byMonth = new Map<string, IMonthSummary>();
  for (const r of records) {
    const month = r.sold_at.slice(0, 7);
    const entry =
      byMonth.get(month) ??
      { month, sellTotal: 0, costTotal: 0, profit: 0, pendingCount: 0, records: [] };
    entry.records.push(r);
    if (r.sell_price === null) {
      entry.pendingCount += 1;
    } else {
      entry.sellTotal += r.sell_price * r.quantity;
      if (r.buy_price > 0) {
        entry.costTotal += r.buy_price * r.quantity;
        entry.profit += (r.sell_price - r.buy_price) * r.quantity;
      }
    }
    byMonth.set(month, entry);
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

export default function LedgerPage() {
  const months = groupByMonth(listSaleRecords());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-neutral-200">交易流水</h1>
        <p className="mt-1 text-sm text-neutral-500">
          刷新库存发现资产从 Steam 库存消失时自动记一笔卖出，卖价优先从 C5
          卖单匹配，没匹配到的在下面补填；月度盈利只统计买卖两头价格都已知的记录（开箱所得成本按未知处理）。
        </p>
      </div>

      {months.length === 0 && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-5 py-10 text-center text-sm text-neutral-500">
          还没有卖出记录——卖掉东西后在持仓页点一次“刷新库存”就会出现在这里
        </div>
      )}

      {months.map((m) => (
        <div key={m.month} className="rounded-lg border border-neutral-800">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-neutral-800 bg-neutral-900 px-4 py-3 text-sm">
            <span className="font-medium text-neutral-200">{m.month}</span>
            <span className="text-neutral-400">
              卖出 {m.records.length - m.pendingCount} 笔 ¥{m.sellTotal.toFixed(2)}
            </span>
            <span className="text-neutral-400">成本 ¥{m.costTotal.toFixed(2)}</span>
            <span className={pnlColor(m.profit)}>已实现盈利 ¥{formatSigned(m.profit)}</span>
            {m.pendingCount > 0 && (
              <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-xs text-orange-400">
                {m.pendingCount} 笔待补卖价
              </span>
            )}
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-neutral-800">
              {m.records.map((r) => {
                const profit =
                  r.sell_price !== null && r.buy_price > 0
                    ? (r.sell_price - r.buy_price) * r.quantity
                    : null;
                return (
                  <tr key={r.id} className="hover:bg-neutral-900/60">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        {r.icon_url ? (
                          // eslint-disable-next-line @next/next/no-img-element -- 外部 Steam CDN 图片，没配 next/image 的 remotePatterns
                          <img
                            src={`${STEAM_ICON_BASE_URL}/${r.icon_url}`}
                            alt={r.name_cn ?? r.item_name}
                            width={32}
                            height={32}
                            className="size-8 shrink-0 rounded bg-neutral-800 object-contain"
                          />
                        ) : (
                          <div className="size-8 shrink-0 rounded bg-neutral-800" />
                        )}
                        <div>
                          <div className="text-neutral-200">{r.name_cn ?? r.item_name}</div>
                          <div className="text-xs text-neutral-500">
                            x{r.quantity} · {new Date(r.sold_at).toLocaleDateString("zh-CN")}
                            {r.sell_source === "c5_order" && " · C5卖单自动匹配"}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-neutral-400">
                      {r.buy_price > 0 ? `买 ¥${r.buy_price.toFixed(2)}` : "开箱"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {r.sell_price !== null ? (
                        <span className="text-neutral-200">卖 ¥{r.sell_price.toFixed(2)}</span>
                      ) : (
                        <EditableSellPrice saleId={r.id} value={r.sell_price} />
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {profit !== null ? (
                        <span className={pnlColor(profit)}>¥{formatSigned(profit)}</span>
                      ) : (
                        <span className="text-neutral-500">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
