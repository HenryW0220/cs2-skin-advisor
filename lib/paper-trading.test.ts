import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPaperTradingTick } from "./paper-trading";

// runPaperTradingTick 直接依赖 better-sqlite3 的 db 模块和 signal-summary 的规则引擎调用，
// 不 mock 掉这些没法在不碰真实数据库的前提下单测"开仓/平仓/冷却"这套决策逻辑本身。
// 用 vi.hoisted 建一份内存态的假仓位表，行为对齐 lib/db/paper-trades.ts 的真实语义
// （open/closed 状态过滤、按 item_name 查冷却），这样才能验证 runPaperTradingTick
// 里"先平后开"的执行顺序、T+7 锁定、30 天超时、冷却期这些真实存在 bug 风险的分支。
const state = vi.hoisted(() => {
  interface FakeTrade {
    id: number;
    item_name: string;
    platform: string;
    buy_price: number;
    buy_score: number;
    buy_reasons: string[];
    opened_at: string;
    status: "open" | "closed";
    sell_price: number | null;
    sell_net_price: number | null;
    sell_score: number | null;
    sell_reasons: string[] | null;
    close_reason: "sell_signal" | "timeout" | "stale_data" | null;
    closed_at: string | null;
  }

  interface MockSignal {
    score: number;
    price: number;
    action: string;
  }

  return {
    trades: [] as FakeTrade[],
    nextId: 1,
    watchlistItems: [] as string[],
    // itemName -> 固定信号，或 (holding) => 信号（同一轮里开仓/平仓两处调用用不同结果时用）
    summaries: {} as Record<string, MockSignal | ((holding: boolean) => MockSignal | null)>,
    platforms: {} as Record<string, string | null>,
    // itemName -> 各平台最后一条已知快照。信号窗口内没数据但要按最后已知价强制平仓时才读。
    latestPrices: {} as Record<string, { platform: string; price: number; captured_at: string }[]>,
  };
});

vi.mock("./db/paper-trades", () => ({
  listOpenPaperTrades: () => state.trades.filter((t) => t.status === "open"),
  hasOpenPaperTrade: (itemName: string) =>
    state.trades.some((t) => t.item_name === itemName && t.status === "open"),
  getLastClosedAt: (itemName: string) => {
    const closed = state.trades
      .filter((t) => t.item_name === itemName && t.status === "closed" && t.closed_at)
      .sort((a, b) => new Date(b.closed_at!).getTime() - new Date(a.closed_at!).getTime());
    return closed[0]?.closed_at ?? null;
  },
  openPaperTrade: (input: {
    item_name: string;
    platform: string;
    buy_price: number;
    buy_score: number;
    buy_reasons: string[];
    opened_at: string;
  }) => {
    state.trades.push({
      id: state.nextId++,
      ...input,
      status: "open",
      sell_price: null,
      sell_net_price: null,
      sell_score: null,
      sell_reasons: null,
      close_reason: null,
      closed_at: null,
    });
  },
  closePaperTrade: (input: {
    id: number;
    sell_price: number;
    sell_net_price: number;
    sell_score: number | null;
    sell_reasons: string[];
    close_reason: "sell_signal" | "timeout" | "stale_data";
    closed_at: string;
  }) => {
    const trade = state.trades.find((t) => t.id === input.id && t.status === "open");
    if (!trade) return;
    Object.assign(trade, { ...input, status: "closed" });
  },
}));

vi.mock("./db/watchlist", () => ({
  listWatchlist: () => state.watchlistItems.map((item_name) => ({ item_name })),
}));

vi.mock("./db/snapshots", () => ({
  getLatestPricesByPlatform: (itemName: string) => state.latestPrices[itemName] ?? [],
}));

vi.mock("./signal-summary", () => ({
  computeSignalSummary: (itemName: string, _platform: string, holding: boolean) => {
    const entry = state.summaries[itemName];
    if (!entry) return null;
    const signal = typeof entry === "function" ? entry(holding) : entry;
    if (!signal) return null;
    return {
      rule: { action: signal.action, score: signal.score, reasons: [`mock:${itemName}`] },
      signals: { price: signal.price },
    };
  },
  pickReferencePlatform: (itemName: string) =>
    itemName in state.platforms ? state.platforms[itemName] : "C5",
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

beforeEach(() => {
  state.trades = [];
  state.nextId = 1;
  state.watchlistItems = [];
  state.summaries = {};
  state.platforms = {};
  state.latestPrices = {};
});

describe("runPaperTradingTick — 开仓", () => {
  it("观察池为空时什么都不做", () => {
    expect(runPaperTradingTick()).toEqual({ opened: 0, closed: 0 });
  });

  it("score 达到 30 且价格 >= 1 时开仓", () => {
    state.watchlistItems = ["Item A"];
    state.summaries["Item A"] = { score: 30, price: 10, action: "HOLD" };

    const result = runPaperTradingTick();

    expect(result).toEqual({ opened: 1, closed: 0 });
    expect(state.trades).toHaveLength(1);
    expect(state.trades[0]).toMatchObject({
      item_name: "Item A",
      platform: "C5",
      buy_price: 10,
      buy_score: 30,
      status: "open",
    });
  });

  it("score 低于 30 不开仓", () => {
    state.watchlistItems = ["Item A"];
    state.summaries["Item A"] = { score: 29, price: 10, action: "HOLD" };

    expect(runPaperTradingTick()).toEqual({ opened: 0, closed: 0 });
  });

  it("价格低于 1 元不开仓（最小报价单位噪声）", () => {
    state.watchlistItems = ["Item A"];
    state.summaries["Item A"] = { score: 80, price: 0.5, action: "HOLD" };

    expect(runPaperTradingTick()).toEqual({ opened: 0, closed: 0 });
  });

  it("已有持仓的饰品不重复开仓", () => {
    state.trades = [
      {
        id: 1,
        item_name: "Item A",
        platform: "C5",
        buy_price: 5,
        buy_score: 30,
        buy_reasons: [],
        opened_at: isoDaysAgo(1),
        status: "open",
        sell_price: null,
        sell_net_price: null,
        sell_score: null,
        sell_reasons: null,
        close_reason: null,
        closed_at: null,
      },
    ];
    state.watchlistItems = ["Item A"];
    state.summaries["Item A"] = { score: 80, price: 10, action: "HOLD" };

    const result = runPaperTradingTick();

    expect(result.opened).toBe(0);
    expect(state.trades).toHaveLength(1);
  });

  it("冷却期内（平仓 <7 天）不重新开仓", () => {
    state.trades = [
      {
        id: 1,
        item_name: "Item A",
        platform: "C5",
        buy_price: 5,
        buy_score: 30,
        buy_reasons: [],
        opened_at: isoDaysAgo(10),
        status: "closed",
        sell_price: 6,
        sell_net_price: 5.9,
        sell_score: -40,
        sell_reasons: [],
        close_reason: "sell_signal",
        closed_at: isoDaysAgo(3),
      },
    ];
    state.watchlistItems = ["Item A"];
    state.summaries["Item A"] = { score: 80, price: 10, action: "HOLD" };

    expect(runPaperTradingTick()).toEqual({ opened: 0, closed: 0 });
  });

  it("冷却期过后（平仓 >=7 天）可以重新开仓", () => {
    state.trades = [
      {
        id: 1,
        item_name: "Item A",
        platform: "C5",
        buy_price: 5,
        buy_score: 30,
        buy_reasons: [],
        opened_at: isoDaysAgo(20),
        status: "closed",
        sell_price: 6,
        sell_net_price: 5.9,
        sell_score: -40,
        sell_reasons: [],
        close_reason: "sell_signal",
        closed_at: isoDaysAgo(8),
      },
    ];
    state.watchlistItems = ["Item A"];
    state.summaries["Item A"] = { score: 80, price: 10, action: "HOLD" };

    const result = runPaperTradingTick();

    expect(result.opened).toBe(1);
    expect(state.trades.filter((t) => t.status === "open")).toHaveLength(1);
  });

  it("拿不到参考平台时不开仓", () => {
    state.watchlistItems = ["Item A"];
    state.summaries["Item A"] = { score: 80, price: 10, action: "HOLD" };
    state.platforms["Item A"] = null;

    expect(runPaperTradingTick()).toEqual({ opened: 0, closed: 0 });
  });

  it("拿不到信号快照（还没同步过价格）时不开仓", () => {
    state.watchlistItems = ["Item A"];
    // 不设置 state.summaries["Item A"]，mock 返回 null

    expect(runPaperTradingTick()).toEqual({ opened: 0, closed: 0 });
  });

  it("观察池同一饰品名重复只开一笔（去重）", () => {
    state.watchlistItems = ["Item A", "Item A"];
    state.summaries["Item A"] = { score: 80, price: 10, action: "HOLD" };

    const result = runPaperTradingTick();

    expect(result.opened).toBe(1);
    expect(state.trades).toHaveLength(1);
  });
});

describe("runPaperTradingTick — 平仓", () => {
  function seedOpenTrade(overrides: Partial<{ opened_at: string; buy_price: number }>) {
    state.trades = [
      {
        id: 1,
        item_name: "Item A",
        platform: "C5",
        buy_price: overrides.buy_price ?? 10,
        buy_score: 30,
        buy_reasons: [],
        opened_at: overrides.opened_at ?? isoDaysAgo(10),
        status: "open",
        sell_price: null,
        sell_net_price: null,
        sell_score: null,
        sell_reasons: null,
        close_reason: null,
        closed_at: null,
      },
    ];
  }

  it("T+7 锁定期内即使有卖出信号也不平仓", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(3) });
    state.summaries["Item A"] = { score: -50, price: 8, action: "SELL" };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(0);
    expect(state.trades[0].status).toBe("open");
  });

  it("锁定期后出现卖出信号时平仓，按 C5 1% 手续费结算净价", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(8), buy_price: 10 });
    state.summaries["Item A"] = { score: -50, price: 20, action: "SELL" };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(1);
    const trade = state.trades[0];
    expect(trade.status).toBe("closed");
    expect(trade.close_reason).toBe("sell_signal");
    expect(trade.sell_price).toBe(20);
    expect(trade.sell_net_price).toBeCloseTo(19.8, 6);
    expect(trade.sell_score).toBe(-50);
  });

  it("持有超过 30 天没有卖出信号时强制超时平仓", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(31), buy_price: 10 });
    state.summaries["Item A"] = { score: 0, price: 15, action: "HOLD" };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(1);
    expect(state.trades[0].close_reason).toBe("timeout");
    expect(state.trades[0].sell_price).toBe(15);
  });

  it("锁定期后没有卖出信号也没超时，继续持仓", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(10) });
    state.summaries["Item A"] = { score: 0, price: 12, action: "HOLD" };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(0);
    expect(state.trades[0].status).toBe("open");
  });

  it("拿不到信号快照但还没超时的持仓本轮跳过，不平仓也不报错", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(10) });
    // 不设置 summaries["Item A"]

    const result = runPaperTradingTick();

    expect(result.closed).toBe(0);
    expect(state.trades[0].status).toBe("open");
  });

  // 饰品被移出观察池后停止同步，SIGNAL_HISTORY_WINDOW_DAYS 天后滑出信号窗口，
  // computeSignalSummary 返回 null。修复前这类仓位会永远挂着不进统计。
  it("信号数据中断且已超时的持仓按最后已知价强制平仓，标记成 stale_data", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(31), buy_price: 10 });
    // 不设置 summaries["Item A"]——信号窗口内没数据
    state.latestPrices["Item A"] = [
      { platform: "C5", price: 20, captured_at: "2026-07-01T00:00:00.000Z" },
    ];

    const result = runPaperTradingTick();

    expect(result.closed).toBe(1);
    const trade = state.trades[0];
    expect(trade.status).toBe("closed");
    expect(trade.close_reason).toBe("stale_data");
    expect(trade.sell_price).toBe(20);
    expect(trade.sell_net_price).toBeCloseTo(19.8, 6); // 同样扣 C5 1% 手续费
    // 没有信号可读，score 存 null 而不是 0——0 会被误读成"算出来是中性分"
    expect(trade.sell_score).toBeNull();
  });

  it("信号数据中断、已超时、但连最后已知价都查不到时保持开仓", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(31) });
    // 既没有 summaries 也没有 latestPrices

    const result = runPaperTradingTick();

    expect(result.closed).toBe(0);
    expect(state.trades[0].status).toBe("open");
  });

  it("最后已知价里没有开仓那个平台时保持开仓，不拿别的平台的价顶替", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(31) });
    state.latestPrices["Item A"] = [
      { platform: "BUFF", price: 99, captured_at: "2026-07-01T00:00:00.000Z" },
    ];

    const result = runPaperTradingTick();

    expect(result.closed).toBe(0);
    expect(state.trades[0].status).toBe("open");
  });

  it("先平后开：本轮平仓的饰品立即受冷却限制，不会当轮重新开仓", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(8), buy_price: 10 });
    state.watchlistItems = ["Item A"];
    // 平仓评估（holding=true）看到 SELL；开仓评估（holding=false）本身信号达标，
    // 唯一能拦住重新开仓的只有"刚平仓触发的冷却"——验证的就是这条边界。
    state.summaries["Item A"] = (holding: boolean) =>
      holding ? { score: -50, price: 20, action: "SELL" } : { score: 50, price: 21, action: "HOLD" };

    const result = runPaperTradingTick();

    expect(result).toEqual({ opened: 0, closed: 1 });
    expect(state.trades).toHaveLength(1);
    expect(state.trades[0].status).toBe("closed");
  });
});
