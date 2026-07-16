"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RemoveWatchlistButton({ id }: { id: number }) {
  const router = useRouter();
  const [removing, setRemoving] = useState(false);

  async function handleClick() {
    setRemoving(true);
    try {
      await fetch(`/api/watchlist/${id}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={removing}
      className="text-xs text-neutral-500 hover:text-red-400 disabled:opacity-50"
    >
      {removing ? "移除中…" : "移除"}
    </button>
  );
}
