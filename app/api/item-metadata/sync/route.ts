import { NextResponse } from "next/server";
import { syncItemMetadata } from "@/lib/item-metadata-sync";

export async function POST() {
  try {
    const summary = await syncItemMetadata();
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
