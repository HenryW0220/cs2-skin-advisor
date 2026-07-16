import Link from "next/link";
import { AiInsight } from "@/components/features/ai-insight";
import { EditableBuyPrice } from "@/components/features/editable-buy-price";
import { RefreshInventoryButton } from "@/components/features/refresh-inventory-button";
import { Sparkline } from "@/components/ui/sparkline";
import { STEAM_ICON_BASE_URL } from "@/lib/api/steam";
import { listInventory } from "@/lib/db/inventory";
import { getLatestPricesByPlatform } from "@/lib/db/snapshots";
import { computeSignalSummary, pickReferencePlatform } from "@/lib/signal-summary";
import type { ITradeAction } from "@/lib/rules/evaluate";

// 跟着 C5GAME/SteamDT 的习惯走：涨=红，跌=绿（国内行情软件的配色，跟欧美的红跌绿涨反过来）。
function pnlColor(value: number): string {
  return value >= 0 ? "text-red-400" : "text-emerald-400";
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

const SORT_KEYS = ["market", "buy", "pnl", "days"] as const;
type ISortKey = (typeof SORT_KEYS)[number];

interface ISearchParams {
  lang?: string;
  q?: string;
  sortBy?: string;
  sortDir?: string;
  merge?: string;
}

function holdingDays(buyDate: string): number {
  const diffMs = Date.now() - new Date(buyDate).getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

function formatSigned(value: number, suffix = ""): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function buildHref(base: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(base)) {
    if (value) params.set(key, value);
  }
  return `/positions?${params.toString()}`;
}

interface IPositionRow {
  ids: number[];
  itemName: string;
  nameCn: string | null;
  iconUrl: string | null;
  quantity: number;
  buyPrice: number; // 多批次合并时是加权平均价
  buyDate: string; // 多批次合并时取最早一批的购入日
  marketPrice: number | null;
  platform: string | null;
  action: ITradeAction | null;
  pnl: number | null;
  pnlPercent: number | null;
  changeTodayPercent: number | null;
  recentPrices: number[];
  editable: boolean; // 合并后的购入价是加权平均，编辑没有意义，只在展开（单批次）时能改
}

// 不合并的展开视图下，同名饰品（同一批 Steam 导入的多个 asset）也不应该被
// created_at 排序拆散到列表各处——把同名的排到一起，但每行还是独立可编辑的。
function groupAdjacentByItemName(rows: IPositionRow[]): IPositionRow[] {
  const groups = new Map<string, IPositionRow[]>();
  for (const row of rows) {
    const list = groups.get(row.itemName) ?? [];
    list.push(row);
    groups.set(row.itemName, list);
  }
  return [...groups.values()].flat();
}

// 同一个 item_name 的多个批次（分开几次买、价格不同）合并成一行，购入价按数量加权平均，
// 持有天数按最早那一批算（持有时间最长的那笔最有参考意义）。
function mergeByItemName(rows: IPositionRow[]): IPositionRow[] {
  const groups = new Map<string, IPositionRow[]>();
  for (const row of rows) {
    const list = groups.get(row.itemName) ?? [];
    list.push(row);
    groups.set(row.itemName, list);
  }

  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];

    const totalQty = group.reduce((sum, r) => sum + r.quantity, 0);
    const totalCost = group.reduce((sum, r) => sum + r.buyPrice * r.quantity, 0);
    const earliest = group.reduce((a, b) => (a.buyDate < b.buyDate ? a : b));
    const marketPrice = group[0].marketPrice;
    const pnl = marketPrice !== null ? marketPrice * totalQty - totalCost : null;
    // 不同批次可能不是每条都有中文名/图标（比如新批次还没跑过 Steam 导入回填），
    // 取组里第一个有值的，不要固定用 group[0]（它可能恰好是缺字段的那条）。
    const withDisplayInfo = group.find((r) => r.nameCn && r.iconUrl) ?? group[0];

    return {
      ids: group.flatMap((r) => r.ids),
      itemName: group[0].itemName,
      nameCn: withDisplayInfo.nameCn,
      iconUrl: withDisplayInfo.iconUrl,
      quantity: totalQty,
      buyPrice: totalQty > 0 ? totalCost / totalQty : 0,
      buyDate: earliest.buyDate,
      marketPrice,
      platform: group[0].platform,
      action: group[0].action,
      pnl,
      pnlPercent: pnl !== null && totalCost > 0 ? (pnl / totalCost) * 100 : null,
      changeTodayPercent: group[0].changeTodayPercent,
      recentPrices: group[0].recentPrices,
      editable: false,
    };
  });
}

export default async function PositionsPage({
  searchParams,
}: {
  searchParams: Promise<ISearchParams>;
}) {
  const sp = await searchParams;
  const showEnglish = sp.lang === "en";
  const query = sp.q?.trim().toLowerCase() ?? "";
  const merged = sp.merge === "true";
  const sortBy = SORT_KEYS.includes(sp.sortBy as ISortKey) ? (sp.sortBy as ISortKey) : undefined;
  const sortDir = sp.sortDir === "asc" ? "asc" : "desc";

  const inventory = listInventory();

  let rows: IPositionRow[] = inventory.map((item) => {
    const platform = pickReferencePlatform(item.item_name);
    const latest = platform
      ? getLatestPricesByPlatform(item.item_name).find((p) => p.platform === platform)
      : undefined;
    const summary = platform ? computeSignalSummary(item.item_name, platform, true) : null;
    const marketPrice = latest?.price ?? null;
    const pnl = marketPrice !== null ? (marketPrice - item.buy_price) * item.quantity : null;
    const pnlPercent =
      marketPrice !== null && item.buy_price > 0
        ? ((marketPrice - item.buy_price) / item.buy_price) * 100
        : null;

    return {
      ids: [item.id],
      itemName: item.item_name,
      nameCn: item.name_cn,
      iconUrl: item.icon_url,
      quantity: item.quantity,
      buyPrice: item.buy_price,
      buyDate: item.buy_date,
      marketPrice,
      platform,
      action: summary?.rule.action ?? null,
      pnl,
      pnlPercent,
      changeTodayPercent: summary?.changeToday?.percent ?? null,
      recentPrices: summary?.recentPrices ?? [],
      editable: true,
    };
  });

  rows = merged ? mergeByItemName(rows) : groupAdjacentByItemName(rows);

  if (query) {
    rows = rows.filter(
      (r) =>
        r.itemName.toLowerCase().includes(query) ||
        (r.nameCn?.toLowerCase().includes(query) ?? false)
    );
  }

  if (sortBy) {
    const sortValue = (row: IPositionRow): number => {
      switch (sortBy) {
        case "market":
          return row.marketPrice ?? NaN;
        case "buy":
          return row.buyPrice;
        case "pnl":
          return row.pnl ?? NaN;
        case "days":
          return holdingDays(row.buyDate);
      }
    };
    const withValue = rows.filter((r) => !Number.isNaN(sortValue(r)));
    const withoutValue = rows.filter((r) => Number.isNaN(sortValue(r)));
    withValue.sort((a, b) => (sortValue(a) - sortValue(b)) * (sortDir === "asc" ? 1 : -1));
    rows = [...withValue, ...withoutValue];
  }

  const totalMarketValue = inventory.reduce((sum, item) => {
    const platform = pickReferencePlatform(item.item_name);
    const latest = platform
      ? getLatestPricesByPlatform(item.item_name).find((p) => p.platform === platform)
      : undefined;
    return sum + (latest?.price ?? 0) * item.quantity;
  }, 0);
  const totalCost = inventory.reduce((sum, item) => sum + item.buy_price * item.quantity, 0);
  const totalPnl = totalMarketValue - totalCost;
  const totalPnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

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
        <div className="grid flex-1 grid-cols-3 gap-4">
          <SummaryCard label="市场价(元)" value={formatMoney(totalMarketValue)} sub={`${inventory.length} 件`} />
          <SummaryCard
            label="总盈亏(元)"
            value={formatSigned(totalPnl)}
            sub={`${formatSigned(totalPnlPercent)}%`}
            valueClassName={pnlColor(totalPnl)}
          />
          <SummaryCard label="购入成本(元)" value={formatMoney(totalCost)} />
        </div>
        <div className="ml-4 flex shrink-0 gap-1 rounded-lg border border-neutral-800 p-1 text-xs">
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
        <form action="/positions" method="GET" className="flex items-center gap-2">
          {sp.lang && <input type="hidden" name="lang" value={sp.lang} />}
          {sp.merge && <input type="hidden" name="merge" value={sp.merge} />}
          <input
            type="text"
            name="q"
            defaultValue={sp.q}
            placeholder="搜索饰品名称（中/英文都行）"
            className="w-64 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </form>
        <div className="flex items-center gap-3">
          <Link
            href={buildHref({ ...sp, merge: merged ? undefined : "true" })}
            className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-100"
          >
            <span
              className={`flex size-4 items-center justify-center rounded border ${merged ? "border-blue-400 bg-blue-500/20 text-blue-400" : "border-neutral-600"}`}
            >
              {merged ? "✓" : ""}
            </span>
            合并相同项
          </Link>
          <RefreshInventoryButton />
        </div>
      </div>

      {merged && (
        <p className="text-xs text-neutral-500">
          已合并同名饰品的多个购入批次，购入价是按数量加权平均算的，这种汇总视图下不能编辑——取消勾选可以展开看每一批的真实购入价并单独修改。
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-4 py-3 text-left">饰品</th>
              <th className="px-4 py-3 text-right">
                <Link href={sortLink("market")}>市场价{sortArrow("market")}</Link>
              </th>
              <th className="px-4 py-3 text-right">
                <Link href={sortLink("buy")}>购入价{sortArrow("buy")}</Link>
              </th>
              <th className="px-4 py-3 text-right">
                <Link href={sortLink("pnl")}>盈亏{sortArrow("pnl")}</Link>
              </th>
              <th className="px-4 py-3 text-right">收益率</th>
              <th className="px-4 py-3 text-right">今日涨跌</th>
              <th className="px-4 py-3 text-center">近7天走势</th>
              <th className="px-4 py-3 text-center">建议</th>
              <th className="px-4 py-3 text-left">AI 建议</th>
              <th className="px-4 py-3 text-right">
                <Link href={sortLink("days")}>持有天数{sortArrow("days")}</Link>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.map((row) => {
              const displayName = (showEnglish ? null : row.nameCn) ?? row.itemName;
              return (
                <tr key={row.ids.join(",")} className="hover:bg-neutral-900/60">
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
                  <td className="px-4 py-3 text-right">
                    {row.editable ? (
                      <EditableBuyPrice itemId={row.ids[0]} value={row.buyPrice} />
                    ) : (
                      <span className="text-neutral-300">¥{formatMoney(row.buyPrice)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.pnl !== null ? (
                      <span className={pnlColor(row.pnl)}>¥{formatSigned(row.pnl)}</span>
                    ) : (
                      <span className="text-neutral-500">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.pnlPercent !== null ? (
                      <span className={pnlColor(row.pnlPercent)}>
                        {formatSigned(row.pnlPercent)}%
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
                    {row.action ? (
                      <span className={`rounded px-2 py-1 text-xs ${ACTION_STYLE[row.action]}`}>
                        {ACTION_LABEL[row.action]}
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-500">暂无信号</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.platform ? (
                      <AiInsight itemName={row.itemName} platform={row.platform} />
                    ) : (
                      <span className="text-xs text-neutral-500">暂无数据</span>
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
                <td colSpan={10} className="px-4 py-10 text-center text-neutral-500">
                  {inventory.length === 0
                    ? "还没有持仓，先点右上角刷新库存或调用 POST /api/inventory 添加"
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
