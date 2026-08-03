import { getDb } from "./client";

export interface IShadowSellSignal {
  id: number;
  trade_id: number;
  item_name: string;
  platform: string;
  rule_version: string;
  action: string;
  reason: string;
  price: number;
  return_24h: number;
  drawdown_48h: number;
  decided_at: string;
  created_at: string;
}

/**
 * 记一条影子卖出决策。**只写不读**——这张表不参与任何真实决策，
 * 是为了并行期结束后能算触发次数和假信号率（见 db/migrations/020）。
 *
 * @returns 是否真的插入了新行。同一笔仓位同一时刻重复写会被 UNIQUE 挡掉返回 false——
 *   模拟盘每小时跑一轮，而 decided_at 用的是快照时间，同步慢一拍时会重复。
 */
export function recordShadowSellSignal(
  signal: Omit<IShadowSellSignal, "id" | "created_at">
): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO shadow_sell_signals
         (trade_id, item_name, platform, rule_version, action, reason, price, return_24h, drawdown_48h, decided_at)
       VALUES
         (@trade_id, @item_name, @platform, @rule_version, @action, @reason, @price, @return_24h, @drawdown_48h, @decided_at)`
    )
    .run(signal);
  return result.changes > 0;
}

export function listShadowSellSignals(action?: string): IShadowSellSignal[] {
  const db = getDb();
  return (
    action
      ? db
          .prepare("SELECT * FROM shadow_sell_signals WHERE action = ? ORDER BY decided_at DESC")
          .all(action)
      : db.prepare("SELECT * FROM shadow_sell_signals ORDER BY decided_at DESC").all()
  ) as IShadowSellSignal[];
}
