import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPaperTradingTick } from "./paper-trading";
import type { PaperTradeCloseReason } from "./types";

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
    close_reason: PaperTradeCloseReason | null;
    closed_at: string | null;
  }

  interface MockSignal {
    score: number;
    price: number;
    action: string;
    // 影子卖出规则用的两个输入，不填就按"没有涨跌数据 + 只有当前价"处理
    changeTodayPercent?: number;
    recentPrices?: number[];
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
    // 影子卖出规则记了什么，用例里断言用。它不该影响任何真实平仓行为。
    shadowSignals: [] as Record<string, unknown>[],
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
    close_reason: PaperTradeCloseReason;
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

// 影子卖出规则的记录表：必须 mock 掉，否则单测会去开真实的 data/db.sqlite 并写入
vi.mock("./db/shadow-sell-signals", () => ({
  recordShadowSellSignal: (signal: Record<string, unknown>) => {
    state.shadowSignals.push(signal);
    return true;
  },
  // 真实实现靠这个去重（同一状态一天只记一条），mock 里按最后一条同 trade 的记录返回
  getLastShadowSellSignal: (tradeId: number) =>
    [...state.shadowSignals].reverse().find((s) => s.trade_id === tradeId),
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
      // 影子卖出规则要读这两个（lib/rules/sell-rule-v2.ts）。少了的话它会在
      // recordShadowDecision 的 try/catch 里静默抛错，整条路径等于没被测到——
      // 第一版就是这样，测试全绿但影子逻辑一次都没真正执行过。
      changeToday: signal.changeTodayPercent === undefined
        ? null
        : { absolute: 0, percent: signal.changeTodayPercent },
      recentPrices: signal.recentPrices ?? [signal.price],
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
  state.shadowSignals = [];
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

  it("T+7 锁定期内即使 v2 出强卖出也不平仓", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(3) });
    state.summaries["Item A"] = {
      score: 0,
      price: 8,
      action: "HOLD",
      changeTodayPercent: 35,
      recentPrices: [6, 7, 8],
    };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(0);
    expect(state.trades[0].status).toBe("open");
  });

  it("锁定期后 v2 出普通卖出（24h 涨幅 15~30%）时平仓，按 C5 1% 手续费结算净价", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(8), buy_price: 10 });
    state.summaries["Item A"] = {
      score: 0, // v1 给 HOLD——平仓已经跟 v1 无关了
      price: 20,
      action: "HOLD",
      changeTodayPercent: 18,
      recentPrices: [15, 17, 20],
    };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(1);
    const trade = state.trades[0];
    expect(trade.status).toBe("closed");
    expect(trade.close_reason).toBe("sell_rule_v2");
    expect(trade.sell_price).toBe(20);
    expect(trade.sell_net_price).toBeCloseTo(19.8, 6);
    // v2 不产出 score，存 null 不存 0
    expect(trade.sell_score).toBeNull();
  });

  it("锁定期后 v2 出强卖出（24h 涨幅 ≥30%）时平仓，close_reason 跟普通档分开记", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(8), buy_price: 10 });
    state.summaries["Item A"] = {
      score: 0,
      price: 20,
      action: "HOLD",
      changeTodayPercent: 42,
      recentPrices: [14, 17, 20],
    };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(1);
    expect(state.trades[0].close_reason).toBe("sell_rule_v2_strong");
    expect(state.trades[0].sell_score).toBeNull();
  });

  // 5~15% 这一档回测超额只有 -3% 上下，扣手续费后不值得换手，v2 刻意不触发。
  // 这条防的是"把阈值往下挪一点点"这种手感式改动。
  it("v2 的整涨幅但没到卖出档（5~15%）不平仓", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(10) });
    state.summaries["Item A"] = {
      score: 0,
      price: 12,
      action: "HOLD",
      changeTodayPercent: 12,
      recentPrices: [11, 11.5, 12],
    };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(0);
    expect(state.trades[0].status).toBe("open");
  });

  // 洗盘否决：48h 深回撤 + 低涨幅时回测超额反而是正的（+2%~+3.7%），明确不卖
  it("洗盘形态（深回撤 + 低涨幅）时 v2 否决卖出，不平仓", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(10) });
    state.summaries["Item A"] = {
      score: 0,
      price: 8,
      action: "HOLD",
      changeTodayPercent: 2,
      recentPrices: [10, 12, 8], // 峰值 12 → 现价 8，回撤 33%
    };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(0);
    expect(state.trades[0].status).toBe("open");
  });

  it("持有超过 30 天且 v2 说不卖时仍然强制超时平仓", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(31), buy_price: 10 });
    state.summaries["Item A"] = {
      score: 0,
      price: 15,
      action: "HOLD",
      changeTodayPercent: 1,
      recentPrices: [14, 15],
    };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(1);
    expect(state.trades[0].close_reason).toBe("timeout");
    expect(state.trades[0].sell_price).toBe(15);
  });

  // 超时和卖出信号同时成立时记成卖出档，不记 timeout——timeout 的含义是"等满 30 天
  // 也没等到信号"，这里明明等到了，混记会让评估时高估超时平仓的占比。
  it("既超时又触发 v2 卖出档时，close_reason 记卖出档", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(31), buy_price: 10 });
    state.summaries["Item A"] = {
      score: 0,
      price: 20,
      action: "HOLD",
      changeTodayPercent: 40,
      recentPrices: [14, 17, 20],
    };

    runPaperTradingTick();

    expect(state.trades[0].close_reason).toBe("sell_rule_v2_strong");
  });

  // v1 的 SELL 不再有任何平仓效力——真实建议还走 v1，但模拟账本已经完全交给 v2
  it("v1 给 SELL 但 v2 说 HOLD 时不平仓", () => {
    seedOpenTrade({ opened_at: isoDaysAgo(10) });
    state.summaries["Item A"] = {
      score: -55,
      price: 12,
      action: "SELL",
      changeTodayPercent: 1,
      recentPrices: [11, 11.5, 12],
    };

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
    // 平仓评估（holding=true）时 v2 出卖出档；开仓评估（holding=false）本身信号达标，
    // 唯一能拦住重新开仓的只有"刚平仓触发的冷却"——验证的就是这条边界。
    state.summaries["Item A"] = (holding: boolean) =>
      holding
        ? { score: 0, price: 20, action: "HOLD", changeTodayPercent: 40, recentPrices: [14, 17, 20] }
        : { score: 50, price: 21, action: "HOLD" };

    const result = runPaperTradingTick();

    expect(result).toEqual({ opened: 0, closed: 1 });
    expect(state.trades).toHaveLength(1);
    expect(state.trades[0].status).toBe("closed");
  });
});

describe("卖出规则 v2 的影子记录", () => {
  function seedOpenTrade(openedDaysAgo = 10) {
    state.trades = [
      {
        id: 1,
        item_name: "Item A",
        platform: "C5",
        buy_price: 10,
        buy_score: 30,
        buy_reasons: [],
        opened_at: isoDaysAgo(openedDaysAgo),
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

  it("过了 T+7 的仓位每轮都会记一条影子判断", () => {
    seedOpenTrade();
    state.summaries["Item A"] = {
      score: 0,
      price: 13,
      action: "HOLD",
      changeTodayPercent: 35,
      recentPrices: [10, 11, 13],
    };

    runPaperTradingTick();

    expect(state.shadowSignals).toHaveLength(1);
    expect(state.shadowSignals[0]).toMatchObject({
      trade_id: 1,
      rule_version: "v2",
      action: "SELL_STRONG",
    });
  });

  // 2026-08-03 之前这条锁的是相反的语义（"v2 说卖，仓位必须还是 open"），那是并行期
  // 的约束。现在模拟盘平仓已经交给 v2，所以要锁的变成"影子记录和真实平仓必须同源"：
  // 同一轮里两边看到的必须是同一个判定，否则影子表和模拟盘流水对不上，
  // 并行期攒的那些数字就没法跟平仓结果互相印证。
  it("影子记录的动作跟真实平仓的档位是同一次判定", () => {
    seedOpenTrade();
    state.summaries["Item A"] = {
      score: 0,
      price: 13,
      action: "HOLD",
      changeTodayPercent: 35,
      recentPrices: [10, 11, 13],
    };

    const result = runPaperTradingTick();

    expect(state.shadowSignals[0].action).toBe("SELL_STRONG");
    expect(result.closed).toBe(1);
    expect(state.trades[0].close_reason).toBe("sell_rule_v2_strong");
    // 平仓理由就是 v2 那条判定的 reason，两边同源
    expect(state.trades[0].sell_reasons).toEqual([state.shadowSignals[0].reason]);
  });

  it("T+7 锁定期内不记——那时候卖不掉，记了也不是可执行的判断", () => {
    seedOpenTrade(3);
    state.summaries["Item A"] = {
      score: 0,
      price: 13,
      action: "HOLD",
      changeTodayPercent: 35,
      recentPrices: [10, 11, 13],
    };

    runPaperTradingTick();

    expect(state.shadowSignals).toHaveLength(0);
  });

  it("HOLD 的仓位照常记影子，不会因为不平仓就漏记", () => {
    seedOpenTrade();
    state.summaries["Item A"] = {
      score: 0,
      price: 13,
      action: "HOLD",
      changeTodayPercent: 3,
      recentPrices: [12, 12.5, 13],
    };

    const result = runPaperTradingTick();

    expect(result.closed).toBe(0);
    expect(state.shadowSignals).toHaveLength(1);
    expect(state.shadowSignals[0].action).toBe("HOLD");
  });
});

describe("PAPER_TRADING_DISABLED 止血开关", () => {
  it("置 1 时整个 tick 跳过：不开仓、不平仓、不记影子", () => {
    vi.stubEnv("PAPER_TRADING_DISABLED", "1");
    state.trades = [
      {
        id: 1,
        item_name: "Item A",
        platform: "C5",
        buy_price: 10,
        buy_score: 30,
        buy_reasons: [],
        opened_at: isoDaysAgo(31), // 既过 T+7 又超时，正常一定会被平掉
        status: "open",
        sell_price: null,
        sell_net_price: null,
        sell_score: null,
        sell_reasons: null,
        close_reason: null,
        closed_at: null,
      },
    ];
    state.watchlistItems = ["Item B"];
    state.summaries["Item A"] = { score: 0, price: 12, action: "HOLD", changeTodayPercent: 40 };
    state.summaries["Item B"] = { score: 80, price: 10, action: "HOLD" };

    const result = runPaperTradingTick();

    expect(result).toEqual({ opened: 0, closed: 0 });
    expect(state.trades[0].status).toBe("open");
    expect(state.shadowSignals).toHaveLength(0);
    vi.unstubAllEnvs();
  });
});
