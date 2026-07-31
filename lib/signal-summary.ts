import { getLatestPricesByPlatform, getRecentPriceHistory } from "./db/snapshots";
import { evaluateSignals, type IRuleResult, type ISignalSnapshot } from "./rules/evaluate";
import {
  computeCrossPlatformSpread,
  type ICrossPlatformSpread,
} from "./signals/cross-platform";
import {
  computeManipulationScore,
  type IManipulationScoreResult,
} from "./signals/manipulation-score";
import { movingAverage } from "./signals/moving-average";
import { resampleHourly } from "./signals/resample";
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
  // 近 7 天的价格，按小时重采样后按时间升序，给走势图用，最多 169 点。
  // 点数刻意跟同步频率解耦，别改回读原始 history——理由见下面计算处的注释。
  recentPrices: number[];
  changeToday: IPriceChange | null; // 跟 24 小时前最近的一条快照比,数据不够时是 null
  manipulation: IManipulationScoreResult | null; // 操盘嫌疑分，历史数据不足 8 天时是 null
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
// prefetchedLatestByPlatform：调用方如果已经查过 getLatestPricesByPlatform（比如同一次
// 循环里 pickReferencePlatform 已经查过），传进来复用，避免同一个饰品在一次请求里被
// 反复查同一张表——持仓页这类批量渲染场景每个饰品少查一次就是几百次 SQL 的差距。
export function computeSignalSummary(
  itemName: string,
  platform: string,
  holding: boolean,
  prefetchedLatestByPlatform?: IPriceSnapshot[]
): ISignalSummary | null {
  const history = getRecentPriceHistory(itemName, platform);
  if (history.length === 0) return null;

  // MA/RSI/成交量异动/嫌疑分这些函数把数组下标当"小时"用，喂之前统一按小时重采样
  // （见 resampleHourly 注释）；changeToday 走原始 history，它是按时间戳查一个点，
  // 不受采样频率影响，用全分辨率更精确。
  const hourly = resampleHourly(history);
  const prices = hourly.map((h) => h.price);
  const volumes = hourly.map((h) => h.volume ?? 0);
  const latestIndex = prices.length - 1;
  const latest = hourly[latestIndex];

  const signals: ISignalSnapshot = {
    price: prices[latestIndex],
    ma7: movingAverage(prices, 7)[latestIndex] ?? null,
    ma30: movingAverage(prices, 30)[latestIndex] ?? null,
    rsi14: rsi(prices, 14)[latestIndex] ?? null,
    volumeAnomalyRatio: detectVolumeAnomaly(volumes)?.ratio ?? null,
  };

  const rule = evaluateSignals(signals, { holding });

  const latestByPlatform = prefetchedLatestByPlatform ?? getLatestPricesByPlatform(itemName);
  const crossPlatformSpread = computeCrossPlatformSpread(
    latestByPlatform.map((p) => ({ platform: p.platform, price: p.price }))
  );

  // 走势图数据点数**必须跟写入频率解耦**，用 hourly 不用 history——这一条踩过坑：
  // 原来这里读原始 history，写的时候（2026-07-26 重采样改造）原始数据就是每小时一条，
  // 7 天 = 168 个点，没问题；但同期上线的 C5 高频 tick 把写入频率提到 10 分钟一次，
  // 同一行代码就变成 7×144≈1000 个点，实测这一列在库里涨到 1.68MB、单品均值 831 点。
  // 后果是每次渲染 /positions 和 /watchlist 都要读+JSON.parse 这 1.68MB，再把上千个
  // 坐标塞进一个 80×28 像素的 SVG（那么小的图最多也就能显示 80 个点，多出来的纯浪费），
  // 顺带还把上千个数字拼进了 LLM 提示词（见 lib/api/nvidia-llm.ts 的价格序列那段）。
  // 用 hourly 之后固定 ≤169 点，以后再怎么调同步频率都不会重演。
  const sevenDaysAgoMs = new Date(latest.captured_at).getTime() - 7 * 24 * 60 * 60 * 1000;
  const recentPrices = hourly
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

  return {
    itemName,
    platform,
    signals,
    rule,
    crossPlatformSpread,
    recentPrices,
    changeToday,
    manipulation: computeManipulationScore(prices),
  };
}

// 持仓/观察池页面展示"市场价"用哪个平台的数据，按国内玩家实际交易习惯排优先级：
// C5（直连数据源，最稳定）> BUFF > 悠悠有品 > 其他。STEAM/HALOSKINS 不是国内玩家主要
// 交易平台（Steam 社区市场余额还有提现折损、标价虚高），getLatestPricesByPlatform
// 已经不收集这两个平台的数据（见 lib/db/snapshots.ts 的 EXCLUDED_PLATFORMS），
// 不会出现在下面的候选列表里。
const PLATFORM_PRIORITY = ["C5", "BUFF", "YOUPIN"];

export function pickReferencePlatform(
  itemName: string,
  prefetchedLatestByPlatform?: IPriceSnapshot[]
): string | null {
  // 价格为 0 的是没挂单/接口没覆盖的死数据（CSMONEY/DMARKET 常见），直接排除。
  const candidates = (prefetchedLatestByPlatform ?? getLatestPricesByPlatform(itemName)).filter(
    (p) => p.price > 0
  );
  if (candidates.length === 0) return null;

  for (const preferred of PLATFORM_PRIORITY) {
    const hit = candidates.find((p) => p.platform === preferred);
    if (hit) return hit.platform;
  }
  return candidates[0].platform;
}
