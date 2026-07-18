import { NextResponse } from "next/server";
import { listAnomalyEvents } from "@/lib/db/anomaly-events";
import type { IAnomalyStatus } from "@/lib/types";

const VALID_STATUS: IAnomalyStatus[] = ["pending", "confirmed", "dismissed"];

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
