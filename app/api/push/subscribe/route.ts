import { NextResponse } from "next/server";
import { addPushSubscription } from "@/lib/db/push-subscriptions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ data: null, error: "缺少 endpoint 或 keys" }, { status: 400 });
    }
    addPushSubscription({ endpoint, p256dh, auth });
    return NextResponse.json({ data: { success: true } });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
