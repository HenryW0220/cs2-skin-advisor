import { NextResponse } from "next/server";
import {
  addManipulationTag,
  listManipulationTags,
  listManipulationTagsForItem,
} from "@/lib/db/manipulation-tags";
import type { IManipulationConfidence } from "@/lib/types";

const VALID_CONFIDENCE: IManipulationConfidence[] = ["high", "medium", "low"];

export async function GET(request: Request) {
  try {
    const itemName = new URL(request.url).searchParams.get("itemName");
    const data = itemName ? listManipulationTagsForItem(itemName) : listManipulationTags();
    return NextResponse.json({ data });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.item_name || !body.start_date) {
      return NextResponse.json(
        { data: null, error: "item_name 和 start_date 是必填的" },
        { status: 400 }
      );
    }
    const confidence: IManipulationConfidence = VALID_CONFIDENCE.includes(body.confidence)
      ? body.confidence
      : "medium";

    const tag = addManipulationTag({
      item_name: body.item_name,
      start_date: body.start_date,
      end_date: body.end_date ?? null,
      confidence,
      note: body.note ?? null,
    });
    return NextResponse.json({ data: tag });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
