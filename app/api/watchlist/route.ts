import { NextResponse } from "next/server";
import { lookupSteamMarketItem } from "@/lib/api/steam";
import { addWatchlistItem, listWatchlist } from "@/lib/db/watchlist";

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
    // 图标/中文名查不到不影响添加成功（可能是还没出 wiki 的新饰品），但要把"没查到精确匹配"
    // 这件事告诉调用方——很可能是磨损度或名字打错了，不应该默默存一条没图标的死数据。
    const lookup = await lookupSteamMarketItem(body.item_name);

    const item = addWatchlistItem({
      item_name: body.item_name,
      name_cn: lookup.data?.nameCn ?? null,
      icon_url: lookup.data?.iconUrl ?? null,
      target_buy_price: body.target_buy_price ?? null,
      target_sell_price: body.target_sell_price ?? null,
      notes: body.notes ?? null,
    });
    return NextResponse.json({
      data: item,
      warning: lookup.error
        ? `没查到饰品"${body.item_name}"的精确匹配，请检查名字和磨损度是否跟 Steam 市场上完全一致（已添加，但暂时没有图标/中文名）`
        : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
