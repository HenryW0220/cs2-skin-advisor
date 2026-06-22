import { NextResponse } from "next/server";
import { computeSignalSummary } from "@/lib/signal-summary";
import { getOrGenerateReason } from "@/lib/reasoning";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const itemName = searchParams.get("itemName");
    const platform = searchParams.get("platform");
    const holding = searchParams.get("holding") !== "false";
    const withReason = searchParams.get("withReason") === "true";

    if (!itemName || !platform) {
      return NextResponse.json(
        { data: null, error: "itemName 和 platform 是必填的 query 参数" },
        { status: 400 }
      );
    }

    const summary = computeSignalSummary(itemName, platform, holding);
    if (!summary) {
      return NextResponse.json(
        { data: null, error: "没有价格数据，先调用 POST /api/sync 拉一次" },
        { status: 404 }
      );
    }

    // 默认不调 LLM，避免每次看面板都触发一次调用；只有显式要理由时才生成（有缓存兜底）。
    const reason = withReason ? await getOrGenerateReason(itemName, summary.rule) : null;

    return NextResponse.json({ data: { ...summary, reason } });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
