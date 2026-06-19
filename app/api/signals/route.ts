import { NextResponse } from "next/server";
import { getLatestPricesByPlatform, getPriceHistory } from "@/lib/db/snapshots";
import { computeCrossPlatformSpread } from "@/lib/signals/cross-platform";
import { movingAverage } from "@/lib/signals/moving-average";
import { rsi } from "@/lib/signals/rsi";
import { detectVolumeAnomaly } from "@/lib/signals/volume";
import { evaluateSignals } from "@/lib/rules/evaluate";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const itemName = searchParams.get("itemName");
    const platform = searchParams.get("platform");
    const holding = searchParams.get("holding") !== "false";

    if (!itemName || !platform) {
      return NextResponse.json(
        { data: null, error: "itemName 和 platform 是必填的 query 参数" },
        { status: 400 }
      );
    }

    const history = getPriceHistory(itemName, platform);
    if (history.length === 0) {
      return NextResponse.json(
        { data: null, error: "没有价格数据，先调用 POST /api/sync 拉一次" },
        { status: 404 }
      );
    }

    const prices = history.map((h) => h.price);
    const volumes = history.map((h) => h.volume ?? 0);
    const latestIndex = prices.length - 1;

    const ma7 = movingAverage(prices, 7)[latestIndex] ?? null;
    const ma30 = movingAverage(prices, 30)[latestIndex] ?? null;
    const rsi14 = rsi(prices, 14)[latestIndex] ?? null;
    const volumeAnomaly = detectVolumeAnomaly(volumes);

    const signals = {
      price: prices[latestIndex],
      ma7,
      ma30,
      rsi14,
      volumeAnomalyRatio: volumeAnomaly?.ratio ?? null,
    };

    const rule = evaluateSignals(signals, { holding });

    const latestByPlatform = getLatestPricesByPlatform(itemName);
    const crossPlatformSpread = computeCrossPlatformSpread(
      latestByPlatform.map((p) => ({ platform: p.platform, price: p.price }))
    );

    return NextResponse.json({
      data: { itemName, platform, signals, rule, crossPlatformSpread },
    });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
