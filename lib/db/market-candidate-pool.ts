import { getDb } from "./client";

export interface IMarketCandidatePoolItem {
  item_name: string;
  rarity: string | null;
  sampled_at: string;
}

export function upsertCandidatePoolItem(item: { item_name: string; rarity: string | null }): void {
  getDb()
    .prepare(
      `INSERT INTO market_candidate_pool (item_name, rarity)
       VALUES (@item_name, @rarity)
       ON CONFLICT(item_name) DO NOTHING`
    )
    .run(item);
}

export function listCandidatePoolItems(): IMarketCandidatePoolItem[] {
  return getDb().prepare("SELECT * FROM market_candidate_pool").all() as IMarketCandidatePoolItem[];
}
