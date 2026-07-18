import { NextResponse } from "next/server";
import {
  getAnomalyEvent,
  listPendingAnomalyEventsForItem,
  updateAnomalyEventStatus,
} from "@/lib/db/anomaly-events";

// 两种"不是操盘"的结论要分开存：
// - category=external：外部事件驱动的真实行情（版本更新/炼金开放/大赛），带 note 记录
//   具体事件——长得跟操盘一样但成因不同，是训练时最有价值的困难负样本；
// - category=noise（默认）：正常波动，普通负样本。
// scope=item 时把这个饰品所有待审核事件一并按同样结论处理（同一波行情不用一条条点）。
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const event = getAnomalyEvent(Number(id));
    if (!event) {
      return NextResponse.json({ data: null, error: "找不到这条异常事件" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const status = body.category === "external" ? "external" : "dismissed";
    const note = body.note ?? null;

    const targets =
      body.scope === "item" ? listPendingAnomalyEventsForItem(event.item_name) : [event];
    for (const target of targets) {
      updateAnomalyEventStatus(target.id, status, note);
    }

    return NextResponse.json({ data: { updated: targets.length, status } });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
