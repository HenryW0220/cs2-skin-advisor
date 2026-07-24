import { NextResponse } from "next/server";
import { syncItemCatalog } from "@/lib/item-catalog-sync";

export async function POST() {
  try {
    const summary = await syncItemCatalog();
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
