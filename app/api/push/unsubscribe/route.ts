import { NextResponse } from "next/server";
import { removePushSubscription } from "@/lib/db/push-subscriptions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const endpoint = body?.endpoint;
    if (!endpoint) {
      return NextResponse.json({ data: null, error: "缺少 endpoint" }, { status: 400 });
    }
    removePushSubscription(endpoint);
    return NextResponse.json({ data: { success: true } });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
