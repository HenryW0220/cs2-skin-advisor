import { NextResponse } from "next/server";
import { deleteInventoryItem, updateInventoryItem } from "@/lib/db/inventory";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    deleteInventoryItem(Number(id));
    return NextResponse.json({ data: { id: Number(id) } });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const updated = updateInventoryItem(Number(id), {
      buy_price: body.buy_price,
      quantity: body.quantity,
      buy_date: body.buy_date,
      notes: body.notes,
    });
    if (!updated) {
      return NextResponse.json({ data: null, error: "找不到这个持仓记录" }, { status: 404 });
    }
    return NextResponse.json({ data: updated });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
