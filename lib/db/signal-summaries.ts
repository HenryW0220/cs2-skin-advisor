import { getDb } from "./client";
import type { ITradeAction } from "../rules/evaluate";

export interface IItemSignalSummary {
  item_name: string;
  platform: string;
  market_price: number;
  action: ITradeAction;
  score: number;
  change_today_percent: number | null;
  recent_prices: string; // JSON number[]，读的时候自己 JSON.parse
  computed_at: string;
}

export function upsertSignalSummary(summary: {
  item_name: string;
  platform: string;
  market_price: number;
  action: ITradeAction;
  score: number;
  change_today_percent: number | null;
  recent_prices: number[];
}): void {
  getDb()
    .prepare(
      `INSERT INTO item_signal_summaries
         (item_name, platform, market_price, action, score, change_today_percent, recent_prices, computed_at)
       VALUES (@item_name, @platform, @market_price, @action, @score, @change_today_percent, @recent_prices, datetime('now'))
       ON CONFLICT(item_name) DO UPDATE SET
         platform = excluded.platform,
         market_price = excluded.market_price,
         action = excluded.action,
         score = excluded.score,
         change_today_percent = excluded.change_today_percent,
         recent_prices = excluded.recent_prices,
         computed_at = excluded.computed_at`
    )
    .run({ ...summary, recent_prices: JSON.stringify(summary.recent_prices) });
}

// 持仓/观察池页面一次性把所有跟踪饰品的信号读出来按 item_name 建 Map，
// 避免每个饰品单独查一次这张表（跟 getLatestPricesByPlatform 之前的问题一样）。
export function listSignalSummaries(): Map<string, IItemSignalSummary> {
  const rows = getDb().prepare("SELECT * FROM item_signal_summaries").all() as IItemSignalSummary[];
  return new Map(rows.map((row) => [row.item_name, row]));
}
