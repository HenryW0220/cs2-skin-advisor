import { NextResponse } from "next/server";
import { syncPriceSnapshots } from "@/lib/sync";

export async function POST() {
  try {
    const summary = await syncPriceSnapshots();
    return NextResponse.json({ data: summary });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
