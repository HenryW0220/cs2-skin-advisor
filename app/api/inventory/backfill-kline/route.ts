import { NextResponse } from "next/server";
import { backfillInventoryKline } from "@/lib/kline-backfill";

// 一次性/偶尔手动触发的操作，不走定时任务——kline 是 90 天滚动窗口，
// 补一次之后靠正常的 /api/sync 续上就行，没必要频繁重跑。
export async function POST() {
  try {
    const summary = await backfillInventoryKline();
    return NextResponse.json({ data: summary });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
