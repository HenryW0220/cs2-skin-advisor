import { getDb } from "./client";
import type { IPaperTrade } from "../types";

export function listPaperTrades(): IPaperTrade[] {
  return getDb()
    .prepare("SELECT * FROM paper_trades ORDER BY opened_at DESC")
    .all() as IPaperTrade[];
}

export function listOpenPaperTrades(): IPaperTrade[] {
  return getDb()
    .prepare("SELECT * FROM paper_trades WHERE status = 'open' ORDER BY opened_at DESC")
    .all() as IPaperTrade[];
}

export function hasOpenPaperTrade(itemName: string): boolean {
  return (
    getDb()
      .prepare("SELECT 1 FROM paper_trades WHERE item_name = ? AND status = 'open' LIMIT 1")
      .get(itemName) !== undefined
  );
}

/** 该饰品最近一次平仓时间（ISO 字符串），没平过仓返回 null。开仓冷却判断用。 */
export function getLastClosedAt(itemName: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT closed_at FROM paper_trades WHERE item_name = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 1"
    )
    .get(itemName) as { closed_at: string } | undefined;
  return row?.closed_at ?? null;
}

export function openPaperTrade(input: {
  item_name: string;
  platform: string;
  buy_price: number;
  buy_score: number;
  buy_reasons: string[];
  opened_at: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO paper_trades (item_name, platform, buy_price, buy_score, buy_reasons, opened_at)
       VALUES (@item_name, @platform, @buy_price, @buy_score, @buy_reasons, @opened_at)`
    )
    .run({ ...input, buy_reasons: JSON.stringify(input.buy_reasons) });
}

export function closePaperTrade(input: {
  id: number;
  sell_price: number;
  sell_net_price: number;
  sell_score: number;
  sell_reasons: string[];
  close_reason: "sell_signal" | "timeout";
  closed_at: string;
}): void {
  getDb()
    .prepare(
      `UPDATE paper_trades
       SET status = 'closed', sell_price = @sell_price, sell_net_price = @sell_net_price,
           sell_score = @sell_score, sell_reasons = @sell_reasons,
           close_reason = @close_reason, closed_at = @closed_at
       WHERE id = @id AND status = 'open'`
    )
    .run({ ...input, sell_reasons: JSON.stringify(input.sell_reasons) });
}
