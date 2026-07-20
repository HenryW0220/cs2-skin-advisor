import { listInventory } from "./db/inventory";
import { listWatchlist } from "./db/watchlist";

// 价格同步、异常扫描、K 线回填三处都要"持仓+观察池"的饰品名单，统一在这收敛，
// 避免三份复制的逻辑各自漂移。
//
// buy_price=0 的持仓（开箱所得，购入渠道未知）不算进跟踪范围：这类饰品占了持仓
// 的大头，之前把它们也纳入扫描，异常审核队列被灌满了根本审不完（见 HANDOFF.md）。
// buy_price>0 才是用户凭消息买入的、真正想盯盘的部分；观察池不受这条限制——
// 观察池本来就是刻意加对照组用的（PLAN.md A3），跟 buy_price 无关。
export function getTrackedItemNames(): string[] {
  const names = new Set<string>();
  for (const item of listInventory()) {
    if (item.buy_price > 0) names.add(item.item_name);
  }
  for (const item of listWatchlist()) names.add(item.item_name);
  return [...names];
}
