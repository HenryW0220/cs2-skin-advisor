import { NextResponse } from "next/server";
import { searchSteamMarketItems } from "@/lib/api/steam";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim();
    if (!q) {
      return NextResponse.json({ data: [] });
    }

    const result = await searchSteamMarketItems(q);
    if (result.error || !result.data) {
      return NextResponse.json({ data: [], error: result.error }, { status: 502 });
    }

    return NextResponse.json({ data: result.data.slice(0, 8) });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
