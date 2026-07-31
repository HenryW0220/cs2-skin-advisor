import { NextResponse } from "next/server";
import { listAnomalyEvents } from "@/lib/db/anomaly-events";
import type { IAnomalyStatus } from "@/lib/types";

// 只是 GET 的查询过滤白名单，不是"允许写入的状态"——写入走 [id]/confirm 和 [id]/dismiss。
const VALID_STATUS: IAnomalyStatus[] = [
  "pending",
  "confirmed",
  "external",
  "dismissed",
  "archived",
];

export async function GET(request: Request) {
  try {
    const statusParam = new URL(request.url).searchParams.get("status");
    const status = VALID_STATUS.includes(statusParam as IAnomalyStatus)
      ? (statusParam as IAnomalyStatus)
      : undefined;
    return NextResponse.json({ data: listAnomalyEvents(status) });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
