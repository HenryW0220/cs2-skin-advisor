import { getLatestPricesByPlatform } from "./db/snapshots";
import { upsertSignalSummary } from "./db/signal-summaries";
import { computeSignalSummary, pickReferencePlatform } from "./signal-summary";

export interface IPrecomputeSummary {
  itemsComputed: number;
}

// 持仓/观察池页面读的信号汇总表，每小时同步收尾时重算一遍（见 lib/sync.ts）。
// score 不区分持仓/观察池（action 才区分），这里固定用 holding=true 算一次就够，
// 观察池页面只用 score、不用 action，读表时忽略 action 字段即可。
// 没有价格数据的饰品（还没 sync 过）跳过，不写空行——页面读表时 Map 里没有这个
// item_name 就按"暂无数据"处理，跟现场计算年代的行为一致。
export function precomputeSignalSummaries(itemNames: string[]): IPrecomputeSummary {
  let itemsComputed = 0;

  for (const itemName of itemNames) {
    const latestByPlatform = getLatestPricesByPlatform(itemName);
    const platform = pickReferencePlatform(itemName, latestByPlatform);
    if (!platform) continue;

    const latest = latestByPlatform.find((p) => p.platform === platform);
    const summary = computeSignalSummary(itemName, platform, true, latestByPlatform);
    if (!latest || !summary) continue;

    upsertSignalSummary({
      item_name: itemName,
      platform,
      market_price: latest.price,
      action: summary.rule.action,
      score: summary.rule.score,
      change_today_percent: summary.changeToday?.percent ?? null,
      recent_prices: summary.recentPrices,
    });
    itemsComputed += 1;
  }

  return { itemsComputed };
}
