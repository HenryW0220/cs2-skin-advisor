// Next.js 服务器启动时执行一次（文档约定的 instrumentation 钩子），
// 用来挂价格快照的定时同步。动态 import 是必须的：这个文件在 edge runtime
// 也会被加载，better-sqlite3 只能在 Node 环境 require。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPriceSyncScheduler } = await import("./lib/scheduler");
    startPriceSyncScheduler();
  }
}
