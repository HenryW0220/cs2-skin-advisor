import { NextResponse } from "next/server";
import { addInventoryItem, listInventory } from "@/lib/db/inventory";

export async function GET() {
  try {
    return NextResponse.json({ data: listInventory() });
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
    const item = addInventoryItem({
      item_name: body.item_name,
      platform: body.platform,
      buy_price: body.buy_price,
      quantity: body.quantity ?? 1,
      buy_date: body.buy_date,
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
