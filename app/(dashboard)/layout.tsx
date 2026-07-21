import Link from "next/link";
import { countPendingAnomalyEvents } from "@/lib/db/anomaly-events";

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pendingAnomalies = countPendingAnomalyEvents();

  return (
    <div className="min-h-full bg-neutral-950 text-neutral-100">
      <nav className="flex items-center gap-6 overflow-x-auto border-b border-neutral-800 px-6 py-4">
        <span className="shrink-0 whitespace-nowrap font-semibold tracking-wide text-neutral-300">
          CS2 皮肤交易决策助手
        </span>
        <Link
          href="/positions"
          className="shrink-0 whitespace-nowrap text-sm text-neutral-400 hover:text-neutral-100"
        >
          持仓
        </Link>
        <Link
          href="/watchlist"
          className="shrink-0 whitespace-nowrap text-sm text-neutral-400 hover:text-neutral-100"
        >
          观察池
        </Link>
        <Link
          href="/anomalies"
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-neutral-400 hover:text-neutral-100"
        >
          异常提醒
          {pendingAnomalies > 0 && (
            <span className="rounded-full bg-orange-500/20 px-1.5 py-0.5 text-xs text-orange-400">
              {pendingAnomalies}
            </span>
          )}
        </Link>
        <Link
          href="/ledger"
          className="shrink-0 whitespace-nowrap text-sm text-neutral-400 hover:text-neutral-100"
        >
          流水
        </Link>
        <Link
          href="/settings"
          className="shrink-0 whitespace-nowrap text-sm text-neutral-400 hover:text-neutral-100"
        >
          设置
        </Link>
      </nav>
      <main className="px-6 py-6">{children}</main>
    </div>
  );
}
