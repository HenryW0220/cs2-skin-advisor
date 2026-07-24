import { NextResponse } from "next/server";
import { lookupSteamMarketItem } from "@/lib/api/steam";
import { getItemCatalogEntry } from "@/lib/db/item-catalog";
import { addWatchlistItem, listWatchlist } from "@/lib/db/watchlist";
import { backfillKlineForItem } from "@/lib/kline-backfill";

export async function GET() {
  try {
    return NextResponse.json({ data: listWatchlist() });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    // 中文名/图标按优先级取：请求自带（前端联想下拉选中的条目已经带全）→ 本地目录
    // 精确匹配 → 最后才实时查 Steam。Steam 查询对服务器 IP 经常 429，能不调就不调；
    // 查不到也不影响添加成功（可能是还没进数据集的新饰品），但要把这件事告诉调用方。
    let nameCn: string | null = body.name_cn ?? null;
    let iconUrl: string | null = body.icon_url ?? null;
    let lookupError: string | undefined;
    if (!nameCn || !iconUrl) {
      const catalogEntry = getItemCatalogEntry(body.item_name);
      if (catalogEntry) {
        nameCn ??= catalogEntry.name_cn;
        iconUrl ??= catalogEntry.icon_url;
      } else {
        const lookup = await lookupSteamMarketItem(body.item_name);
        nameCn ??= lookup.data?.nameCn ?? null;
        iconUrl ??= lookup.data?.iconUrl ?? null;
        lookupError = lookup.error;
      }
    }

    const item = addWatchlistItem({
      item_name: body.item_name,
      name_cn: nameCn,
      icon_url: iconUrl,
      target_buy_price: body.target_buy_price ?? null,
      target_sell_price: body.target_sell_price ?? null,
      notes: body.notes ?? null,
    });

    // 新加的品立刻回填 90 天小时级历史，技术指标/嫌疑分从第一天就有完整数据可算；
    // 回填失败不影响添加成功（之后手动点"回填90天K线"还能补）。
    const backfill = await backfillKlineForItem(body.item_name);

    return NextResponse.json({
      data: item,
      warning: lookupError
        ? `没查到饰品"${body.item_name}"的精确匹配，请检查名字和磨损度是否跟 Steam 市场上完全一致（已添加，但暂时没有图标/中文名）`
        : backfill.error
          ? `已添加，但回填历史价格失败（${backfill.error}），可稍后在持仓页点"回填90天K线"重试`
          : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
