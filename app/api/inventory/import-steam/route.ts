import { NextResponse } from "next/server";
import { importSteamInventory } from "@/lib/inventory-import";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const steamId = body.steamId ?? process.env.STEAM_USER_ID;
    if (!steamId) {
      return NextResponse.json(
        { data: null, error: "没有 steamId，请求体传 steamId 或者配置 STEAM_USER_ID 环境变量" },
        { status: 400 }
      );
    }

    const summary = await importSteamInventory(steamId);
    if (summary.error) {
      return NextResponse.json({ data: null, error: summary.error }, { status: 502 });
    }
    return NextResponse.json({ data: summary });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
