import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeSignalSummary } from "./signal-summary";
import type { IPriceSnapshot } from "./types";

// computeSignalSummary 直接读 better-sqlite3，mock 掉取数那一层就能在不碰真实库的前提下
// 验证"输入什么频率的快照 → 输出什么形状的 recentPrices"。这里只关心走势图数据的形状，
// 信号数值本身由 lib/signals/* 各自的单测覆盖。
const state = vi.hoisted(() => ({ history: [] as IPriceSnapshot[] }));

vi.mock("./db/snapshots", () => ({
  getRecentPriceHistory: () => state.history,
  getLatestPricesByPlatform: () => [],
}));

function buildHistory(intervalMinutes: number, days: number): IPriceSnapshot[] {
  const endMs = Date.parse("2026-07-31T00:00:00.000Z");
  const step = intervalMinutes * 60 * 1000;
  const count = Math.floor((days * 24 * 60) / intervalMinutes);
  const snapshots: IPriceSnapshot[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    snapshots.push({
      id: i,
      item_name: "AK-47 | Redline (Field-Tested)",
      platform: "C5",
      // 价格随时间线性上升，这样"重采样保留每小时最后一条"是否成立可以从数值上验证
      price: 100 + (count - 1 - i),
      volume: 10,
      captured_at: new Date(endMs - i * step).toISOString(),
      created_at: new Date(endMs - i * step).toISOString(),
    } as IPriceSnapshot);
  }
  return snapshots;
}

describe("computeSignalSummary 的 recentPrices", () => {
  beforeEach(() => {
    state.history = [];
  });

  it("每小时一条快照时，近 7 天最多 169 个点（168 个整点间隔，首尾都含）", () => {
    state.history = buildHistory(60, 30);
    const summary = computeSignalSummary("AK-47 | Redline (Field-Tested)", "C5", true);
    expect(summary).not.toBeNull();
    expect(summary!.recentPrices.length).toBeLessThanOrEqual(169);
  });

  // 这条是这个文件存在的主要理由：C5 高频 tick（10 分钟一次）上线后，原来读原始 history
  // 的写法会让走势图点数涨到约 1000，一个 80 像素宽的 SVG 根本显示不了那么多，白白撑大
  // item_signal_summaries 表、页面 HTML 和 LLM 提示词。点数必须只跟时间跨度有关，
  // 跟写入频率无关——以后谁再调同步频率，这条会先失败。
  it("写入频率提高到 10 分钟一次，点数不跟着涨", () => {
    state.history = buildHistory(10, 30);
    const summary = computeSignalSummary("AK-47 | Redline (Field-Tested)", "C5", true);
    expect(summary).not.toBeNull();
    expect(summary!.recentPrices.length).toBeLessThanOrEqual(169);
  });

  it("同一段行情，10 分钟频率和 1 小时频率给出同样长度的走势", () => {
    state.history = buildHistory(60, 30);
    const hourly = computeSignalSummary("AK-47 | Redline (Field-Tested)", "C5", true)!.recentPrices;
    state.history = buildHistory(10, 30);
    const fast = computeSignalSummary("AK-47 | Redline (Field-Tested)", "C5", true)!.recentPrices;
    expect(fast.length).toBe(hourly.length);
  });

  it("重采样保留每小时最后一条，走势仍然按时间升序", () => {
    state.history = buildHistory(10, 30);
    const prices = computeSignalSummary("AK-47 | Redline (Field-Tested)", "C5", true)!.recentPrices;
    expect(prices.length).toBeGreaterThan(1);
    for (let i = 1; i < prices.length; i += 1) {
      expect(prices[i]).toBeGreaterThan(prices[i - 1]);
    }
  });
});
