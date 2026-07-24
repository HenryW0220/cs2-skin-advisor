import { NextResponse } from "next/server";
import { searchSteamMarketItems } from "@/lib/api/steam";
import { countItemCatalog, searchItemCatalog } from "@/lib/db/item-catalog";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim();
    if (!q) {
      return NextResponse.json({ data: [] });
    }

    // 优先查本地目录：不受 Steam 对服务器 IP 的 429 限流影响，也没有 Steam
    // 搜索"每页 10 条按热度排"导致目标磨损被截掉的问题。目录空表示还没同步过
    // （设置页手动触发），这时回退到 Steam 实时搜索保底。
    if (countItemCatalog() > 0) {
      const rows = searchItemCatalog(q, 20);
      return NextResponse.json({
        data: rows.map((row) => ({
          marketHashName: row.market_hash_name,
          nameCn: row.name_cn,
          iconUrl: row.icon_url ?? "",
        })),
      });
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
