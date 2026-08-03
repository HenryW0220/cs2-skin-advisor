import {
  closePaperTrade,
  getLastClosedAt,
  hasOpenPaperTrade,
  listOpenPaperTrades,
  openPaperTrade,
} from "./db/paper-trades";
import { getLastShadowSellSignal, recordShadowSellSignal } from "./db/shadow-sell-signals";
import { getLatestPricesByPlatform } from "./db/snapshots";
import { listWatchlist } from "./db/watchlist";
import { netSellPrice } from "./fees";
import { evaluateSellV2, type ISellV2Result } from "./rules/sell-rule-v2";
import { computeSignalSummary, pickReferencePlatform, type ISignalSummary } from "./signal-summary";
import type { IPaperTrade, PaperTradeCloseReason } from "./types";

// 开仓门槛：规则引擎买入侧 score ≥ 30，等于至少 RSI 超卖（+30）这个量级的信号——
// 纯"趋势走强"只有 +15，作为买入依据太弱，会把模拟盘灌满噪声交易。
const ENTRY_MIN_SCORE = 30;

// 几分钱的印花价格本身就是一分两分地跳，模拟收益全是价格粒度的机械结果，挡在入口。
// 出发点和 lib/anomaly-scan.ts 的 MIN_PRICE_FOR_ANOMALY_SCAN 一样，但**数值不同且是有意的**：
// 那边 2026-07-31 按人工审核确认率提到了 5，这边没有对应的实测依据（模拟盘至今零平仓，
// 没有已实现收益能用来回算低价品的信噪比），所以维持 1，等有平仓样本后再单独校准。
const MIN_ENTRY_PRICE = 1;

// T+7 交易保护（2026-07-15 新规）：买入锁定 7 天，锁定期内出了卖出信号也只能干看着。
// 不带这条约束的模拟数字全是假的（PLAN.md 原则 6：60% 的历史盘 7 天内就过峰）。
const T7_LOCK_MS = 7 * 24 * 60 * 60 * 1000;

// 卖出信号可能长期不触发（v2 要 24h 涨幅 ≥15%，回测里这三档合计只占全部饰品-小时的
// 2.7%）——超过这个天数还没信号就按当前价强制平仓，不然仓位永远挂着，统计里全是
// 没结论的未平仓交易。30 天也和"观察池信号验证"的耐心上限差不多。这是兜底，不是卖出规则。
const MAX_HOLD_MS = 30 * 24 * 60 * 60 * 1000;

// 平仓后同一饰品的再开仓冷却。信号在阈值附近抖动时会平了马上又开，
// 一段行情被切成好几笔重复交易，统计意义上是同一个决策不该重复计数。
const REENTRY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// 模拟卖出按 C5 普通用户费率扣手续费（1%，lib/fees.ts）。
const SELL_FEE_KEY = "c5";

// 影子卖出规则的版本号，同一张表里可以并存多版对比（见 db/migrations/020）
const SHADOW_RULE_VERSION = "v2";
// 动作没变的情况下，隔多久才补记一条。取 24 小时是为了让长期 HOLD 也有连续性可查，
// 又不会把表撑成每小时一条的流水（119 笔过 T+7 的仓位不去重就是每天 2856 行）。
const SHADOW_REDUNDANT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IPaperTradingSummary {
  opened: number;
  closed: number;
}

/** v2 判定当时的 24h 涨跌幅，**小数不是百分数**（changeToday 存的是百分数）。 */
function return24hOf(summary: ISignalSummary): number {
  return (summary.changeToday?.percent ?? 0) / 100;
}

/**
 * 跑一次卖出规则 v2。
 *
 * **一轮里只调用这一次，结果同时喂给真实平仓和影子记录**——两边必须是同一次判定，
 * 各算各的话影子表和模拟盘流水就对不上，两组数字没法互相印证，并行期记录也就白记了。
 */
function evaluateSellDecision(summary: ISignalSummary): ISellV2Result {
  return evaluateSellV2({
    return24h: return24hOf(summary),
    hourlyPrices: summary.recentPrices,
  });
}

/**
 * 把 v2 的判断记一条影子记录。**跟真实平仓用的是同一个 verdict**（由调用方传进来），
 * 但两边记的对象不同，都要留着：影子记的是"每轮全部过 T+7 的仓位怎么判"，
 * 模拟盘只记真实平仓那一下。
 *
 * 失败不能影响模拟盘本身——这只是个观察记录，出问题宁可少一条数据也不能让平仓逻辑挂掉。
 */
function recordShadowDecision(
  trade: IPaperTrade,
  summary: ISignalSummary,
  verdict: ISellV2Result
): void {
  try {
    // 去重：模拟盘每小时一轮，同一个持续状态不去重的话一天记 24 条，
    // "触发次数"就没意义了（持续 5 小时的卖出信号是一次信号不是五次）。
    // 动作变了就记新的一条；动作没变则每天补记一条，这样长期 HOLD 也有连续性可查。
    const last = getLastShadowSellSignal(trade.id, SHADOW_RULE_VERSION);
    if (
      last &&
      last.action === verdict.action &&
      Date.now() - new Date(last.decided_at).getTime() < SHADOW_REDUNDANT_WINDOW_MS
    ) {
      return;
    }

    recordShadowSellSignal({
      trade_id: trade.id,
      item_name: trade.item_name,
      platform: trade.platform,
      rule_version: SHADOW_RULE_VERSION,
      action: verdict.action,
      reason: verdict.reason,
      price: summary.signals.price,
      return_24h: return24hOf(summary),
      drawdown_48h: verdict.drawdown48h,
      decided_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[paper-trading] 影子规则记录失败（不影响模拟盘）：", err);
  }
}

// v2 的两档分别记成不同的 close_reason，不合并成一个 'signal'：回测里两档的超额差了
// 一个数量级（>30% 档 -18.69%，15~30% 档 -4.35%~-5.89%），评估时必须能拆开看。
const CLOSE_REASON_BY_ACTION: Record<string, PaperTradeCloseReason | undefined> = {
  SELL_STRONG: "sell_rule_v2_strong",
  SELL: "sell_rule_v2",
};

/**
 * 每小时价格同步后跑一遍模拟盘：观察池饰品买入信号达标就模拟开仓（买入侧仍走
 * 规则引擎 v1 的 score），已开仓位过了 T+7 锁定期后**卖出规则 v2** 出 SELL/SELL_STRONG
 * （或持有超时）就模拟平仓。
 *
 * 已知的简化（评估结果时要记得）：
 * - 买入按参考平台在售价成交（吃单价，现实里做得到）；卖出也按在售价扣 1% 手续费算，
 *   这偏乐观——真挂单可能要压价才卖得掉，低价品还有流动性折价（PLAN.md C3 提过）。
 * - 不模拟仓位大小，每笔都是"1 件"，收益率按单件算。
 */
export function runPaperTradingTick(): IPaperTradingSummary {
  // 止血开关：平仓判定换成 v2 之后如果发现平得太凶（或者别的什么不对），SSH 上去在
  // .env.local 加一行 PAPER_TRADING_DISABLED=1 + `docker compose restart` 就能掐掉整个
  // tick，几秒生效、不用 rebuild（做法同 C5_FAST_SYNC_DISABLED）。开仓和影子记录一起停，
  // 因为要止的是"模拟盘继续往前跑"这件事本身，留一半反而让流水更难解释。
  if (process.env.PAPER_TRADING_DISABLED === "1") {
    console.log("[paper-trading] PAPER_TRADING_DISABLED=1，本轮跳过模拟盘");
    return { opened: 0, closed: 0 };
  }

  const now = Date.now();
  let opened = 0;
  let closed = 0;

  // 先平后开：同一轮里刚平仓的饰品受再开仓冷却约束，顺序反了会平仓当小时就重新买回来。
  for (const trade of listOpenPaperTrades()) {
    const heldMs = now - new Date(trade.opened_at).getTime();
    if (heldMs < T7_LOCK_MS) continue;

    const timedOut = heldMs >= MAX_HOLD_MS;
    const summary = computeSignalSummary(trade.item_name, trade.platform, true);

    // 信号窗口内一条快照都没有——饰品被移出观察池后就不再同步，SIGNAL_HISTORY_WINDOW_DAYS
    // 天后它就滑出窗口了。没数据判断不了卖出信号，但也不能让仓位永远挂着不进统计
    // （不平仓 = 这笔决策永远没有结论，是模拟盘验证实验里最没用的一种状态）：
    // 超过最长持有期照样平掉，按最后一条已知快照价成交。close_reason 单独标记成
    // stale_data，因为成交价不是"决策当时"的价，评估胜率时要把这批剔掉。
    if (!summary) {
      if (!timedOut) continue;
      const lastKnown = getLatestPricesByPlatform(trade.item_name).find(
        (p) => p.platform === trade.platform
      );
      if (!lastKnown) continue;

      closePaperTrade({
        id: trade.id,
        sell_price: lastKnown.price,
        sell_net_price: netSellPrice(lastKnown.price, SELL_FEE_KEY).net,
        sell_score: null,
        sell_reasons: [`价格数据中断（最后一条快照 ${lastKnown.captured_at}），按最后已知价格强制平仓`],
        close_reason: "stale_data",
        closed_at: new Date(now).toISOString(),
      });
      closed += 1;
      continue;
    }

    // 模拟盘的平仓判定走卖出规则 v2（2026-08-03 起）。**注意这只改模拟账本**——
    // /positions 页面上给人看的买卖建议仍然由 v1（lib/rules/evaluate.ts）出，一个字没动。
    // 换成 v2 是因为 v1 卖出侧结构上永远触发不了（score ≤ -40 要超买+趋势走弱同时成立，
    // 实测 325 个饰品 0 个），230 笔仓位注定全部走 30 天超时平仓，而 timeout 的含义是
    // "持满 30 天按当时价卖掉"，对"卖出规则准不准"零信息量——模拟盘存在的意义就是验证
    // 卖出规则，用一个永不触发的规则去验证等于什么都没验。v2 的阈值全部从回测反推
    // （lib/rules/sell-rule-v2.ts 文件头有完整依据表）。
    const verdict = evaluateSellDecision(summary);
    recordShadowDecision(trade, summary, verdict);

    const sellCloseReason = CLOSE_REASON_BY_ACTION[verdict.action];
    if (!sellCloseReason && !timedOut) continue;

    closePaperTrade({
      id: trade.id,
      sell_price: summary.signals.price,
      sell_net_price: netSellPrice(summary.signals.price, SELL_FEE_KEY).net,
      // v2 不产出 v1 那种 score。存 null 不存 0——0 会被误读成"算出来是中性分"
      // （stale_data 那次已经踩过）。触发的是哪一档记在 close_reason 里。
      sell_score: null,
      sell_reasons: [verdict.reason],
      close_reason: sellCloseReason ?? "timeout",
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
