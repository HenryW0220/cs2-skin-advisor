import { NextResponse } from "next/server";
import { addPushSubscription, listPushSubscriptions } from "@/lib/db/push-subscriptions";

// 这条路由**必须留日志**：2026-08 那次"点了订阅但库里没有记录"，两侧都查不出发生了什么——
// Caddy 当时没配 access log，容器这边也没有任何请求痕迹，最后只能靠翻数据库备份复原。
// 一行 console.log 换的是"下次能立刻分清是浏览器没发出来还是服务端没写进去"。
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      console.warn("[push-subscribe] 请求到达但字段不全", {
        hasEndpoint: Boolean(endpoint),
        hasP256dh: Boolean(p256dh),
        hasAuth: Boolean(auth),
      });
      return NextResponse.json({ data: null, error: "缺少 endpoint 或 keys" }, { status: 400 });
    }

    addPushSubscription({ endpoint, p256dh, auth });
    const total = listPushSubscriptions().length;
    console.log(`[push-subscribe] 已登记 ${String(endpoint).slice(0, 40)}…，当前共 ${total} 条订阅`);
    return NextResponse.json({ data: { success: true, total } });
  } catch (err) {
    console.error("[push-subscribe] 写入失败", err);
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
