import type { IPriceSnapshot } from "../types";

const HOUR_MS = 60 * 60 * 1000;

/**
 * 把价格快照序列按 UTC 整点小时重采样：每个小时桶只保留时间最晚的一条。
 *
 * 嫌疑分/洗盘/追涨/成交量异动这些信号函数把数组下标当"过去第 N 小时"用
 * （比如 slice(-24) 就是"最近24小时"），这个假设只有在输入严格一小时一个点时才成立——
 * 现在整点同步和 K 线回填天然满足，但如果某个数据源以后单独提高写入频率（比如只给 C5
 * 加密同步），不重采样会让所有下标窗口和阈值静默算错（阈值是按小时级数据校准出来的，
 * 见 manipulation-score.ts 顶部注释）。所有喂给这些信号函数的价格/成交量数组都要先过这层。
 *
 * @param history 按 captured_at 升序排列的快照（getPriceHistory 保证的顺序）
 */
export function resampleHourly(history: IPriceSnapshot[]): IPriceSnapshot[] {
  const byHour = new Map<number, IPriceSnapshot>();
  for (const snap of history) {
    const hourMs = Math.floor(new Date(snap.captured_at).getTime() / HOUR_MS) * HOUR_MS;
    // 同一小时桶多次 set 只更新 value，不改变 key 的插入顺序——因为输入按时间升序，
    // 桶的插入顺序天然就是时间升序，不需要再排序一遍。
    byHour.set(hourMs, snap);
  }
  return [...byHour.values()];
}
