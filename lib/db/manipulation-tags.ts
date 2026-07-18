import { getDb } from "./client";
import type { IManipulationConfidence, IManipulationTag } from "../types";

export function listManipulationTags(): IManipulationTag[] {
  return getDb()
    .prepare("SELECT * FROM manipulation_tags ORDER BY start_date DESC")
    .all() as IManipulationTag[];
}

export function listManipulationTagsForItem(itemName: string): IManipulationTag[] {
  return getDb()
    .prepare("SELECT * FROM manipulation_tags WHERE item_name = ? ORDER BY start_date DESC")
    .all(itemName) as IManipulationTag[];
}

export function addManipulationTag(tag: {
  item_name: string;
  start_date: string;
  end_date: string | null;
  confidence: IManipulationConfidence;
  note: string | null;
}): IManipulationTag {
  const result = getDb()
    .prepare(
      `INSERT INTO manipulation_tags (item_name, start_date, end_date, confidence, note)
       VALUES (@item_name, @start_date, @end_date, @confidence, @note)`
    )
    .run(tag);
  return getDb()
    .prepare("SELECT * FROM manipulation_tags WHERE id = ?")
    .get(result.lastInsertRowid as number) as IManipulationTag;
}

export function deleteManipulationTag(id: number): void {
  getDb().prepare("DELETE FROM manipulation_tags WHERE id = ?").run(id);
}
