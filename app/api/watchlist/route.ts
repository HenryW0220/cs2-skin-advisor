import { NextResponse } from "next/server";
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
    const item = addWatchlistItem({
      item_name: body.item_name,
      target_buy_price: body.target_buy_price ?? null,
      target_sell_price: body.target_sell_price ?? null,
      notes: body.notes ?? null,
    });
    return NextResponse.json({ data: item });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
