import Link from "next/link";
import { STEAM_ICON_BASE_URL } from "@/lib/api/steam";
import { listInventory } from "@/lib/db/inventory";
import { getLatestPricesByPlatform } from "@/lib/db/snapshots";
import { computeSignalSummary, pickReferencePlatform } from "@/lib/signal-summary";
import type { ITradeAction } from "@/lib/rules/evaluate";

// 跟着 C5GAME/SteamDT 的习惯走：涨=红，跌=绿（国内行情软件的配色，跟欧美的红跌绿涨反过来）。
function pnlColor(pnl: number): string {
  return pnl >= 0 ? "text-red-400" : "text-emerald-400";
}

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

function holdingDays(buyDate: string): number {
  const diffMs = Date.now() - new Date(buyDate).getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

interface IPositionRow {
  id: number;
  itemName: string;
  nameCn: string | null;
  iconUrl: string | null;
  quantity: number;
  buyPrice: number;
  buyDate: string;
  marketPrice: number | null;
  action: ITradeAction | null;
}

export default async function PositionsPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const { lang } = await searchParams;
  // 中文名只有 Steam 导入的饰品才有，手动添加的没有，没有的话不管选哪个语言都退回显示英文名。
  const showEnglish = lang === "en";

  const inventory = listInventory();

  const rows: IPositionRow[] = inventory.map((item) => {
    const platform = pickReferencePlatform(item.item_name);
    const latest = platform
      ? getLatestPricesByPlatform(item.item_name).find((p) => p.platform === platform)
      : undefined;
    const summary = platform ? computeSignalSummary(item.item_name, platform, true) : null;

    return {
      id: item.id,
      itemName: item.item_name,
      nameCn: item.name_cn,
      iconUrl: item.icon_url,
      quantity: item.quantity,
      buyPrice: item.buy_price,
      buyDate: item.buy_date,
      marketPrice: latest?.price ?? null,
      action: summary?.rule.action ?? null,
    };
  });

  const totalMarketValue = rows.reduce((sum, r) => sum + (r.marketPrice ?? 0) * r.quantity, 0);
  const totalCost = rows.reduce((sum, r) => sum + r.buyPrice * r.quantity, 0);
  const totalPnl = rows.reduce(
    (sum, r) => sum + ((r.marketPrice ?? r.buyPrice) - r.buyPrice) * r.quantity,
    0
  );
  const totalPnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="grid flex-1 grid-cols-3 gap-4">
          <SummaryCard label="市场价(元)" value={formatMoney(totalMarketValue)} sub={`${rows.length} 件`} />
          <SummaryCard
            label="总盈亏(元)"
            value={`${totalPnl >= 0 ? "+" : ""}${formatMoney(totalPnl)}`}
            sub={`${totalPnlPercent >= 0 ? "+" : ""}${totalPnlPercent.toFixed(2)}%`}
            valueClassName={pnlColor(totalPnl)}
          />
          <SummaryCard label="购入成本(元)" value={formatMoney(totalCost)} />
        </div>
        <div className="ml-4 flex shrink-0 gap-1 rounded-lg border border-neutral-800 p-1 text-xs">
          <Link
            href="/positions?lang=zh"
            className={`rounded px-2 py-1 ${!showEnglish ? "bg-neutral-800 text-neutral-100" : "text-neutral-500"}`}
          >
            中文
          </Link>
          <Link
            href="/positions?lang=en"
            className={`rounded px-2 py-1 ${showEnglish ? "bg-neutral-800 text-neutral-100" : "text-neutral-500"}`}
          >
            EN
          </Link>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-4 py-3 text-left">饰品</th>
              <th className="px-4 py-3 text-right">市场价</th>
              <th className="px-4 py-3 text-right">购入价</th>
              <th className="px-4 py-3 text-right">盈亏</th>
              <th className="px-4 py-3 text-center">建议</th>
              <th className="px-4 py-3 text-right">持有天数</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.map((row) => {
              const pnl =
                row.marketPrice !== null ? (row.marketPrice - row.buyPrice) * row.quantity : null;
              const pnlPercent =
                row.marketPrice !== null && row.buyPrice > 0
                  ? ((row.marketPrice - row.buyPrice) / row.buyPrice) * 100
                  : null;
              const displayName = (showEnglish ? null : row.nameCn) ?? row.itemName;
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
                      <div>
                        <div className="font-medium">{displayName}</div>
                        <div className="text-xs text-neutral-500">x{row.quantity}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.marketPrice !== null ? `¥${formatMoney(row.marketPrice)}` : "暂无数据"}
                  </td>
                  <td className="px-4 py-3 text-right text-neutral-400">
                    ¥{formatMoney(row.buyPrice)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {pnl !== null && pnlPercent !== null ? (
                      <span className={pnlColor(pnl)}>
                        {pnl >= 0 ? "+" : ""}
                        {formatMoney(pnl)}（{pnlPercent >= 0 ? "+" : ""}
                        {pnlPercent.toFixed(2)}%）
                      </span>
                    ) : (
                      <span className="text-neutral-500">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {row.action ? (
                      <span className={`rounded px-2 py-1 text-xs ${ACTION_STYLE[row.action]}`}>
                        {ACTION_LABEL[row.action]}
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-500">暂无信号</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-neutral-400">
                    {holdingDays(row.buyDate)} 天
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-neutral-500">
                  还没有持仓，先调用 POST /api/inventory 添加
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-5 py-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${valueClassName ?? "text-neutral-100"}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}
