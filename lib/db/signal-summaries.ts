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

/**
 * 上一次**完整同步**跑完的时间（SQLite 的 `YYYY-MM-DD HH:MM:SS`，UTC），没跑过返回 null。
 *
 * 用这张表的 `computed_at` 当"完整同步跑完了"的标志，是因为 `precomputeSignalSummaries`
 * 是 lib/sync.ts 整条流水线的**最后一步**——它写了就说明前面的抓价、异常扫描、模拟盘
 * 都跑完了。中途崩掉的话这个时间不会更新，下次启动就会补跑，正是想要的行为。
 *
 * **不要改回用 price_snapshots 的最新写入时间**：C5 高频 tick 每 10 分钟就写一次快照，
 * 那个时间永远是新的，会让"距离上次同步多久"永远显示几分钟，启动补跑判断彻底失效
 * （2026-07-31 实测：部署两次之后完整同步停摆两小时，页面数据一直是旧的）。
 */
export function getLastFullSyncTime(): string | null {
  const row = getDb()
    .prepare("SELECT MAX(computed_at) AS latest FROM item_signal_summaries")
    .get() as { latest: string | null };
  return row.latest;
}

// 持仓/观察池页面一次性把所有跟踪饰品的信号读出来按 item_name 建 Map，
// 避免每个饰品单独查一次这张表（跟 getLatestPricesByPlatform 之前的问题一样）。
export function listSignalSummaries(): Map<string, IItemSignalSummary> {
  const rows = getDb().prepare("SELECT * FROM item_signal_summaries").all() as IItemSignalSummary[];
  return new Map(rows.map((row) => [row.item_name, row]));
}
