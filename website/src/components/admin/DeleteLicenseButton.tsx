"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Admin: delete a customer's license key. Two-step to avoid accidents — the
 * first click arms an inline warning, the second actually deletes and refreshes
 * the dashboard. `licenseKey` is shown in the warning so it's clear WHICH key.
 */
export function DeleteLicenseButton({
  licenseId,
  licenseKey,
}: {
  licenseId: string;
  licenseKey: string;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/license", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not delete license.");
      }
      setArmed(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        title="Delete this license key"
        className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-2.5 py-1 text-xs font-medium text-red-300 transition-colors hover:border-red-500/50 hover:bg-red-500/10"
      >
        <i className="fa-solid fa-trash text-[10px]" />
        Delete
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-right text-[11px] leading-tight text-red-300">
        Permanently delete <span className="font-mono">{licenseKey}</span> and
        its device activations? The customer loses access.
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/50 bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/25 disabled:opacity-60"
        >
          {busy ? (
            <i className="fa-solid fa-circle-notch animate-spin text-[10px]" />
          ) : (
            <i className="fa-solid fa-trash text-[10px]" />
          )}
          Confirm delete
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          disabled={busy}
          className="rounded-lg px-2 py-1 text-xs text-neutral-400 transition-colors hover:text-white"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
