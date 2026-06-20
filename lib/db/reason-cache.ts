import { getDb } from "./client";

export function getCachedReason(cacheKey: string): string | null {
  const row = getDb()
    .prepare("SELECT reason FROM reason_cache WHERE cache_key = ?")
    .get(cacheKey) as { reason: string } | undefined;
  return row?.reason ?? null;
}

export function setCachedReason(cacheKey: string, itemName: string, reason: string): void {
  getDb()
    .prepare(
      `INSERT INTO reason_cache (cache_key, item_name, reason)
       VALUES (@cacheKey, @itemName, @reason)
       ON CONFLICT(cache_key) DO UPDATE SET reason = @reason`
    )
    .run({ cacheKey, itemName, reason });
}
