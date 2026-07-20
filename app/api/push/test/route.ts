import { NextResponse } from "next/server";
import { sendPushNotification } from "@/lib/api/web-push";

export async function POST() {
  const result = await sendPushNotification({
    title: "测试通知",
    body: "推送通道工作正常。",
  });
  if (result.error) {
    return NextResponse.json({ data: null, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ data: result.data });
}
