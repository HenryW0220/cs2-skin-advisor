import { getLastFullSyncTime } from "./db/signal-summaries";
import { syncC5PricesOnly, syncPriceSnapshots } from "./sync";

// 技术指标（MA7/MA30/RSI14）需要连续的历史数据，只靠手动点"刷新价格"会断档，
// 所以服务器启动后自动定时同步。间隔 1 小时：SteamDT/C5 都是批量接口各调 1 次，
// 频率再高对日线级别的指标没有增益，只是白白消耗 API 配额。
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

// C5 批量接口没有 SteamDT 那种硬限流（见 lib/sync.ts::syncC5PricesOnly 注释），单独
// 给它加一个更高频的 tick，只写快照，让 C5 这一路（参考平台优先级第一位，见
// lib/signal-summary.ts 的 PLATFORM_PRIORITY）的数据比整点同步更新。
const C5_FAST_SYNC_INTERVAL_MS = 10 * 60 * 1000;

// SQLite 的 datetime('now') 存的是 UTC 的 "YYYY-MM-DD HH:MM:SS"，直接 new Date()
// 会被 JS 按本地时区解析，这里补上 T 和 Z 按 UTC 解析。
function parseSqliteUtc(value: string): number {
  return new Date(`${value.replace(" ", "T")}Z`).getTime();
}

async function runSyncSafely(trigger: string): Promise<void> {
  try {
    const summary = await syncPriceSnapshots();
    console.log(
      `[price-sync] ${trigger}: ${summary.itemCount} 个饰品，写入 ${summary.snapshotCount} 条快照` +
        (summary.errors.length > 0 ? `，${summary.errors.length} 个错误（如 ${summary.errors[0].error}）` : "") +
        (summary.anomaliesDetected > 0 ? `，新发现 ${summary.anomaliesDetected} 个异常波动` : "") +
        (summary.paperTradesOpened > 0 ? `，模拟盘开仓 ${summary.paperTradesOpened} 笔` : "") +
        (summary.paperTradesClosed > 0 ? `，模拟盘平仓 ${summary.paperTradesClosed} 笔` : "")
    );
  } catch (err) {
    console.error(`[price-sync] ${trigger} 失败:`, err instanceof Error ? err.message : err);
  }
}

async function runC5FastSyncSafely(): Promise<void> {
  try {
    const summary = await syncC5PricesOnly();
    console.log(
      `[c5-fast-sync] ${summary.itemCount} 个饰品，写入 ${summary.snapshotCount} 条快照` +
        (summary.errors.length > 0 ? `，${summary.errors.length} 个错误（如 ${summary.errors[0].error}）` : "") +
        (summary.earlyScanTriggered
          ? `，检测到短时大幅波动（${summary.earlyScanItems.slice(0, 3).join("、")}${summary.earlyScanItems.length > 3 ? ` 等${summary.earlyScanItems.length}个` : ""}），已提前跑一次完整异常扫描`
          : "")
    );
  } catch (err) {
    console.error("[c5-fast-sync] 失败:", err instanceof Error ? err.message : err);
  }
}

// dev 模式热重载会反复执行 instrumentation 的 register，用 globalThis 保证定时器只挂一次。
const globalScheduler = globalThis as typeof globalThis & {
  __priceSyncTimer?: ReturnType<typeof setInterval>;
  __c5FastSyncTimer?: ReturnType<typeof setInterval>;
};

export function startPriceSyncScheduler(): void {
  // 常驻采集器（next start，见 PLAN.md A2）跑起来之后，开发用的 dev server 不该
  // 再重复同步——SteamDT/C5 配额有限，双进程双倍消耗。.env.development 里设了
  // 这个开关，只影响 next dev，不影响生产采集器。
  if (process.env.PRICE_SYNC_DISABLED === "1") {
    console.log("[price-sync] PRICE_SYNC_DISABLED=1，本进程不做定时同步（由常驻采集器负责）");
    return;
  }
  if (globalScheduler.__priceSyncTimer) return;

  globalScheduler.__priceSyncTimer = setInterval(() => {
    void runSyncSafely("定时");
  }, SYNC_INTERVAL_MS);
  // 不阻止进程退出（比如 next build 之后的脚本收尾）。
  globalScheduler.__priceSyncTimer.unref?.();

  // 启动时距离上次**完整同步**超过一个间隔就立即补一次；刚同步过就不补，
  // 避免 dev 服务器反复重启时每次都打一轮 API。
  //
  // 判断依据必须是"完整同步跑完的时间"而不是"最近写过快照的时间"——C5 高频 tick
  // 每 10 分钟写一次快照，用后者的话这里永远算出几分钟、补跑永远不触发，而定时器
  // 又是从启动时刻重新计时的，结果是**每次部署都让异常扫描/模拟盘/信号预计算停摆
  // 最多一小时**（2026-07-31 实测停了两小时，页面数据一直显示两小时前的价）。
  const latest = getLastFullSyncTime();
  const staleMs = latest ? Date.now() - parseSqliteUtc(latest) : Infinity;
  if (staleMs >= SYNC_INTERVAL_MS) {
    void runSyncSafely("启动补跑");
  } else {
    const minutes = Math.round(staleMs / 60000);
    console.log(`[price-sync] 上次完整同步是 ${minutes} 分钟前，跳过启动补跑，定时器已挂上（每小时一次）`);
  }

  // 独立开关：出问题时不用碰整点大同步，改 C5_FAST_SYNC_DISABLED=1 重启容器就能单独关掉
  // 这个 tick（改的是 .env.local，docker compose restart 不用重新 build，几秒钟生效）。
  if (process.env.C5_FAST_SYNC_DISABLED === "1") {
    console.log("[c5-fast-sync] C5_FAST_SYNC_DISABLED=1，不启动高频 tick");
  } else {
    globalScheduler.__c5FastSyncTimer = setInterval(() => {
      void runC5FastSyncSafely();
    }, C5_FAST_SYNC_INTERVAL_MS);
    globalScheduler.__c5FastSyncTimer.unref?.();
    console.log(`[c5-fast-sync] 已启动，每 ${C5_FAST_SYNC_INTERVAL_MS / 60000} 分钟一次`);
  }
}
