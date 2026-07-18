import { NextResponse } from "next/server";
import { deleteManipulationTag } from "@/lib/db/manipulation-tags";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    deleteManipulationTag(Number(id));
    return NextResponse.json({ data: { id: Number(id) } });
  } catch (err) {
    return NextResponse.json(
      { data: null, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
