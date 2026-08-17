"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Admin: toggle whether a purchase counts toward total revenue. `counts` is the
 * current state (true = status "complete"). Excluding sets status "excluded" so
 * the payment stays on record but drops out of every revenue/spend total —
 * useful for test/sandbox payments. Single click; no confirm (it's reversible).
 */
export function PurchaseRevenueToggle({
  purchaseId,
  counts,
}: {
  purchaseId: string;
  counts: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/purchase", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purchaseId,
          action: counts ? "exclude" : "include",
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not update purchase.");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={
          counts
            ? "Exclude this purchase from revenue totals (e.g. a test payment)"
            : "Count this purchase toward revenue again"
        }
        className={
          counts
            ? "inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-neutral-300 transition-colors hover:border-white/25 hover:text-white disabled:opacity-60"
            : "inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.08] px-2.5 py-1 text-xs font-medium text-emerald-300 transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/15 disabled:opacity-60"
        }
      >
        {busy ? (
          <i className="fa-solid fa-circle-notch animate-spin text-[10px]" />
        ) : (
          <i
            className={`fa-solid text-[10px] ${counts ? "fa-ban" : "fa-rotate-left"}`}
          />
        )}
        {counts ? "Exclude" : "Re-count"}
      </button>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
