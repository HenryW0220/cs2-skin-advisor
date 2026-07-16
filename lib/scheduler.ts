import { getLatestSnapshotTime } from "./db/snapshots";
import { syncPriceSnapshots } from "./sync";

// 技术指标（MA7/MA30/RSI14）需要连续的历史数据，只靠手动点"刷新价格"会断档，
// 所以服务器启动后自动定时同步。间隔 1 小时：SteamDT/C5 都是批量接口各调 1 次，
// 频率再高对日线级别的指标没有增益，只是白白消耗 API 配额。
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

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
        (summary.errors.length > 0 ? `，${summary.errors.length} 个错误（如 ${summary.errors[0].error}）` : "")
    );
  } catch (err) {
    console.error(`[price-sync] ${trigger} 失败:`, err instanceof Error ? err.message : err);
  }
}

// dev 模式热重载会反复执行 instrumentation 的 register，用 globalThis 保证定时器只挂一次。
const globalScheduler = globalThis as typeof globalThis & {
  __priceSyncTimer?: ReturnType<typeof setInterval>;
};

export function startPriceSyncScheduler(): void {
  if (globalScheduler.__priceSyncTimer) return;

  globalScheduler.__priceSyncTimer = setInterval(() => {
    void runSyncSafely("定时");
  }, SYNC_INTERVAL_MS);
  // 不阻止进程退出（比如 next build 之后的脚本收尾）。
  globalScheduler.__priceSyncTimer.unref?.();

  // 启动时距离上次同步超过一个间隔就立即补一次；刚同步过就不补，
  // 避免 dev 服务器反复重启时每次都打一轮 API。
  const latest = getLatestSnapshotTime();
  const staleMs = latest ? Date.now() - parseSqliteUtc(latest) : Infinity;
  if (staleMs >= SYNC_INTERVAL_MS) {
    void runSyncSafely("启动补跑");
  } else {
    const minutes = Math.round(staleMs / 60000);
    console.log(`[price-sync] 上次同步是 ${minutes} 分钟前，跳过启动补跑，定时器已挂上（每小时一次）`);
  }
}
