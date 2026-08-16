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
  /** 决策瞬间口径的 24h 涨幅（小数）。**v2 的判定用的就是这个**，见 lib/signal-summary.ts 的 changeToday。 */
  return_24h: number;
  /**
   * 小时桶口径的同一个量（小数），**只观察不参与决策**（迁移 027）。
   *
   * 存两份是因为影子和回测的取样方式不同：影子在决策瞬间判、回测按整点桶取样，
   * 实测 31.8% 的样本取值不同、最大差 16.4pp。只存一份的话，"影子 5~15% 档"和
   * "回测 5~15% 档"装的不是同一批样本，而两个数看起来完全可以相减——
   * 我们已经在这上面差点得出过错误结论（REPORT-hold-5to15-attribution.md）。
   *
   * 小时桶不足 25 个（不够回看 24 小时）时是 null；迁移之前的历史行也是 null。
   */
  return_24h_bucket: number | null;
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
         (trade_id, item_name, platform, rule_version, action, reason, price, return_24h, return_24h_bucket, drawdown_48h, decided_at)
       VALUES
         (@trade_id, @item_name, @platform, @rule_version, @action, @reason, @price, @return_24h, @return_24h_bucket, @drawdown_48h, @decided_at)`
    )
    .run(signal);
  return result.changes > 0;
}

/**
 * 某笔仓位最近一条影子记录。用来去重：模拟盘每小时跑一轮，同一个持续状态
 * 不去重的话一天会记 24 条，"触发次数"这个指标就废了——一个持续 5 小时的卖出信号
 * 是**一次**信号不是五次。
 */
export function getLastShadowSellSignal(
  tradeId: number,
  ruleVersion: string
): IShadowSellSignal | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM shadow_sell_signals
       WHERE trade_id = ? AND rule_version = ?
       ORDER BY decided_at DESC LIMIT 1`
    )
    .get(tradeId, ruleVersion) as IShadowSellSignal | undefined;
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
