import Link from "next/link";

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="min-h-full bg-neutral-950 text-neutral-100">
      <nav className="flex items-center gap-6 border-b border-neutral-800 px-6 py-4">
        <span className="font-semibold tracking-wide text-neutral-300">
          CS2 皮肤交易决策助手
        </span>
        <Link href="/positions" className="text-sm text-neutral-400 hover:text-neutral-100">
          持仓
        </Link>
        <Link href="/watchlist" className="text-sm text-neutral-400 hover:text-neutral-100">
          观察池
        </Link>
      </nav>
      <main className="px-6 py-6">{children}</main>
    </div>
  );
}
