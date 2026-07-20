import { NextResponse } from "next/server";
import { netSellPrice } from "@/lib/fees";
import { updateSaleSellPrice } from "@/lib/db/sales";

// body: { sell_price: 平台成交价（未扣费）, fee_key: 平台费率预设 key（见 lib/fees.ts） }
// 入库的 sell_price 是扣完交易手续费的净到手价，盈利按净到手算。
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const gross = Number(body.sell_price);
    if (!Number.isFinite(gross) || gross < 0) {
      return NextResponse.json({ data: null, error: "sell_price 必须是非负数字" }, { status: 400 });
    }
    const { net, label } = netSellPrice(gross, String(body.fee_key ?? "none"));
    const record = updateSaleSellPrice(Number(id), net, gross, label);
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
