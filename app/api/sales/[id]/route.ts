import { NextResponse } from "next/server";
import { updateSaleSellPrice } from "@/lib/db/sales";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const sellPrice = Number(body.sell_price);
    if (!Number.isFinite(sellPrice) || sellPrice < 0) {
      return NextResponse.json({ data: null, error: "sell_price 必须是非负数字" }, { status: 400 });
    }
    const record = updateSaleSellPrice(Number(id), sellPrice);
    if (!record) {
      return NextResponse.json({ data: null, error: "找不到这条卖出记录" }, { status: 404 });
    }
    return NextResponse.json({ data: record });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
