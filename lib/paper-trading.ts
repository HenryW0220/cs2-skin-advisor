import {
  closePaperTrade,
  getLastClosedAt,
  hasOpenPaperTrade,
  listOpenPaperTrades,
  openPaperTrade,
} from "./db/paper-trades";
import { listWatchlist } from "./db/watchlist";
import { netSellPrice } from "./fees";
import { computeSignalSummary, pickReferencePlatform } from "./signal-summary";

// 开仓门槛：规则引擎买入侧 score ≥ 30，等于至少 RSI 超卖（+30）这个量级的信号——
// 纯"趋势走强"只有 +15，作为买入依据太弱，会把模拟盘灌满噪声交易。
const ENTRY_MIN_SCORE = 30;

// 几分钱的印花价格本身就是一分两分地跳，模拟收益全是价格粒度的机械结果，
// 和 lib/anomaly-scan.ts 的 MIN_PRICE_FOR_ANOMALY_SCAN 同理，挡在入口。
const MIN_ENTRY_PRICE = 1;

// T+7 交易保护（2026-07-15 新规）：买入锁定 7 天，锁定期内出了卖出信号也只能干看着。
// 不带这条约束的模拟数字全是假的（PLAN.md 原则 6：60% 的历史盘 7 天内就过峰）。
const T7_LOCK_MS = 7 * 24 * 60 * 60 * 1000;

// 规则引擎的 SELL 阈值（score ≤ -40）要 RSI 超买+趋势走弱这种组合才够得着，冷清的品
// 可能长期不触发——超过这个天数还没信号就按当前价强制平仓，不然仓位永远挂着，
// 统计里全是没结论的未平仓交易。30 天也和"观察池信号验证"的耐心上限差不多。
const MAX_HOLD_MS = 30 * 24 * 60 * 60 * 1000;

// 平仓后同一饰品的再开仓冷却。信号在阈值附近抖动时会平了马上又开，
// 一段行情被切成好几笔重复交易，统计意义上是同一个决策不该重复计数。
const REENTRY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// 模拟卖出按 C5 普通用户费率扣手续费（1%，lib/fees.ts）。
const SELL_FEE_KEY = "c5";

export interface IPaperTradingSummary {
  opened: number;
  closed: number;
}

/**
 * 每小时价格同步后跑一遍模拟盘：观察池饰品买入信号达标就模拟开仓，
 * 已开仓位过了 T+7 锁定期后出 SELL 信号（或持有超时）就模拟平仓。
 *
 * 已知的简化（评估结果时要记得）：
 * - 买入按参考平台在售价成交（吃单价，现实里做得到）；卖出也按在售价扣 1% 手续费算，
 *   这偏乐观——真挂单可能要压价才卖得掉，低价品还有流动性折价（PLAN.md C3 提过）。
 * - 不模拟仓位大小，每笔都是"1 件"，收益率按单件算。
 */
export function runPaperTradingTick(): IPaperTradingSummary {
  const now = Date.now();
  let opened = 0;
  let closed = 0;

  // 先平后开：同一轮里刚平仓的饰品受再开仓冷却约束，顺序反了会平仓当小时就重新买回来。
  for (const trade of listOpenPaperTrades()) {
    const summary = computeSignalSummary(trade.item_name, trade.platform, true);
    if (!summary) continue;

    const heldMs = now - new Date(trade.opened_at).getTime();
    if (heldMs < T7_LOCK_MS) continue;

    const sellSignal = summary.rule.action === "SELL";
    const timedOut = heldMs >= MAX_HOLD_MS;
    if (!sellSignal && !timedOut) continue;

    closePaperTrade({
      id: trade.id,
      sell_price: summary.signals.price,
      sell_net_price: netSellPrice(summary.signals.price, SELL_FEE_KEY).net,
      sell_score: summary.rule.score,
      sell_reasons: summary.rule.reasons,
      close_reason: sellSignal ? "sell_signal" : "timeout",
      closed_at: new Date(now).toISOString(),
    });
    closed += 1;
  }

  // 观察池可能有重复饰品名（不同行同名），去重后每个饰品最多一笔模拟仓。
  const watchlistNames = [...new Set(listWatchlist().map((w) => w.item_name))];
  for (const itemName of watchlistNames) {
    if (hasOpenPaperTrade(itemName)) continue;

    const lastClosedAt = getLastClosedAt(itemName);
    if (lastClosedAt && now - new Date(lastClosedAt).getTime() < REENTRY_COOLDOWN_MS) continue;

    const platform = pickReferencePlatform(itemName);
    if (!platform) continue;

    const summary = computeSignalSummary(itemName, platform, false);
    if (!summary) continue;
    if (summary.rule.score < ENTRY_MIN_SCORE) continue;
    if (summary.signals.price < MIN_ENTRY_PRICE) continue;

    openPaperTrade({
      item_name: itemName,
      platform,
      buy_price: summary.signals.price,
      buy_score: summary.rule.score,
      buy_reasons: summary.rule.reasons,
      opened_at: new Date(now).toISOString(),
    });
    opened += 1;
  }

  return { opened, closed };
}
