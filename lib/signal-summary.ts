import { getLatestPricesByPlatform, getPriceHistory } from "./db/snapshots";
import { evaluateSignals, type IRuleResult, type ISignalSnapshot } from "./rules/evaluate";
import {
  computeCrossPlatformSpread,
  type ICrossPlatformSpread,
} from "./signals/cross-platform";
import { movingAverage } from "./signals/moving-average";
import { rsi } from "./signals/rsi";
import { detectVolumeAnomaly } from "./signals/volume";
import type { IPriceSnapshot } from "./types";

export interface IPriceChange {
  absolute: number;
  percent: number;
}

export interface ISignalSummary {
  itemName: string;
  platform: string;
  signals: ISignalSnapshot;
  rule: IRuleResult;
  crossPlatformSpread: ICrossPlatformSpread | null;
  recentPrices: number[]; // 近 7 天内的快照价格，按时间升序，给走势图用
  changeToday: IPriceChange | null; // 跟 24 小时前最近的一条快照比,数据不够时是 null
}

function findSnapshotAtOrBefore(
  history: IPriceSnapshot[],
  beforeMs: number
): IPriceSnapshot | undefined {
  let result: IPriceSnapshot | undefined;
  for (const snap of history) {
    if (new Date(snap.captured_at).getTime() <= beforeMs) {
      result = snap;
    } else {
      break;
    }
  }
  return result;
}

// 给一个饰品在指定价格数据平台上算出最新的技术指标 + 规则引擎结论 + 跨平台价差。
// 没有价格数据（还没 sync 过）时返回 null，调用方决定怎么提示用户。
export function computeSignalSummary(
  itemName: string,
  platform: string,
  holding: boolean
): ISignalSummary | null {
  const history = getPriceHistory(itemName, platform);
  if (history.length === 0) return null;

  const prices = history.map((h) => h.price);
  const volumes = history.map((h) => h.volume ?? 0);
  const latestIndex = prices.length - 1;
  const latest = history[latestIndex];

  const signals: ISignalSnapshot = {
    price: prices[latestIndex],
    ma7: movingAverage(prices, 7)[latestIndex] ?? null,
    ma30: movingAverage(prices, 30)[latestIndex] ?? null,
    rsi14: rsi(prices, 14)[latestIndex] ?? null,
    volumeAnomalyRatio: detectVolumeAnomaly(volumes)?.ratio ?? null,
  };

  const rule = evaluateSignals(signals, { holding });

  const latestByPlatform = getLatestPricesByPlatform(itemName);
  const crossPlatformSpread = computeCrossPlatformSpread(
    latestByPlatform.map((p) => ({ platform: p.platform, price: p.price }))
  );

  const sevenDaysAgoMs = new Date(latest.captured_at).getTime() - 7 * 24 * 60 * 60 * 1000;
  const recentPrices = history
    .filter((h) => new Date(h.captured_at).getTime() >= sevenDaysAgoMs)
    .map((h) => h.price);

  const dayAgoMs = new Date(latest.captured_at).getTime() - 24 * 60 * 60 * 1000;
  const priorSnapshot = findSnapshotAtOrBefore(history.slice(0, -1), dayAgoMs);
  const changeToday = priorSnapshot
    ? {
        absolute: latest.price - priorSnapshot.price,
        percent:
          priorSnapshot.price > 0
            ? ((latest.price - priorSnapshot.price) / priorSnapshot.price) * 100
            : 0,
      }
    : null;

  return { itemName, platform, signals, rule, crossPlatformSpread, recentPrices, changeToday };
}

// 持仓/观察池页面展示"市场价"用哪个平台的数据，按国内玩家实际交易习惯排优先级：
// C5（直连数据源，最稳定）> BUFF > 悠悠有品 > 其他，STEAM 永远垫底——Steam 余额
// 有提现折损，标价虚高，不能代表真实能成交的行情价。
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];

export function pickReferencePlatform(itemName: string): string | null {
  // 价格为 0 的是没挂单/接口没覆盖的死数据（CSMONEY/DMARKET 常见），直接排除。
  const candidates = getLatestPricesByPlatform(itemName).filter((p) => p.price > 0);
  if (candidates.length === 0) return null;

  for (const preferred of PLATFORM_PRIORITY) {
    const hit = candidates.find((p) => p.platform === preferred);
    if (hit) return hit.platform;
  }
  const nonSteam = candidates.find((p) => p.platform !== "STEAM");
  return (nonSteam ?? candidates[0]).platform;
}
