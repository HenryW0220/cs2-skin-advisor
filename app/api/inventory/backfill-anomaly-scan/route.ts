import { NextResponse } from "next/server";
import { scanHistoricalPriceAnomalies } from "@/lib/anomaly-scan";

// 一次性回溯扫描持仓饰品回填出来的完整历史，直接从已有数据里挖出候选异常窗口，
// 不用等未来再发生一次。跟 /api/sync 里每次自动跑的实时检测是同一套算法，
// 只是这个会把整段历史都过一遍，不止最新一点。
export async function POST() {
  try {
    const summary = scanHistoricalPriceAnomalies();
    return NextResponse.json({ data: summary });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
