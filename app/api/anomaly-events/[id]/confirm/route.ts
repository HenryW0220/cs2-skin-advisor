import { NextResponse } from "next/server";
import { addManipulationTag } from "@/lib/db/manipulation-tags";
import {
  getAnomalyEvent,
  listPendingAnomalyEventsForItem,
  updateAnomalyEventStatus,
} from "@/lib/db/anomaly-events";
import type { IManipulationConfidence } from "@/lib/types";

const VALID_CONFIDENCE: IManipulationConfidence[] = ["high", "medium", "low"];
const METRIC_LABEL: Record<string, string> = {
  price_zscore: "价格异常波动",
  volume_ratio: "成交量异常放大",
  manipulation_score: "操盘嫌疑分",
  collection_linkage: "同收藏品联动",
  washout_signal: "疑似洗盘",
};

// 确认这个自动检测到的异常确实是操盘：生成对应的操盘标记（正样本）。
// scope=item 时把这个饰品所有待审核事件当同一轮操盘一并确认，
// 标记的时间窗口取这批事件的最早~最晚检测时间（用户传了 end_date 就用用户的）。
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
    const confidence: IManipulationConfidence = VALID_CONFIDENCE.includes(body.confidence)
      ? body.confidence
      : "medium";

    const targets =
      body.scope === "item" ? listPendingAnomalyEventsForItem(event.item_name) : [event];
    const detectedDates = targets.map((t) => t.detected_at.slice(0, 10)).sort();
    const startDate = detectedDates[0];
    const spanEndDate = detectedDates[detectedDates.length - 1];

    const tag = addManipulationTag({
      item_name: event.item_name,
      start_date: startDate,
      end_date: body.end_date ?? (spanEndDate !== startDate ? spanEndDate : null),
      confidence,
      note:
        body.note ??
        `由自动异常检测确认（${targets.length} 个异常点，如 ${METRIC_LABEL[event.metric] ?? event.metric} ${event.value.toFixed(2)}）`,
    });

    for (const target of targets) {
      updateAnomalyEventStatus(target.id, "confirmed", body.note ?? null);
    }

    return NextResponse.json({ data: { updated: targets.length, tag } });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
