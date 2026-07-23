export default function PositionsLoading() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-lg border border-neutral-800 bg-neutral-900 px-5 py-4">
            <div className="h-3 w-16 rounded bg-neutral-800" />
            <div className="mt-2 h-7 w-24 rounded bg-neutral-800" />
          </div>
        ))}
      </div>
      <div className="h-9 w-64 rounded border border-neutral-800 bg-neutral-900" />
      <div className="overflow-hidden rounded-lg border border-neutral-800">
        <div className="h-10 bg-neutral-900" />
        <div className="divide-y divide-neutral-800">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className="size-10 shrink-0 rounded bg-neutral-800" />
              <div className="h-4 w-40 rounded bg-neutral-800" />
              <div className="ml-auto h-4 w-16 rounded bg-neutral-800" />
              <div className="h-4 w-16 rounded bg-neutral-800" />
              <div className="h-4 w-16 rounded bg-neutral-800" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
