"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Admin: clear all device activations for a customer's license (support tool for
 * "I changed PCs and I'm locked out"). Two-step to avoid accidents. Disabled
 * when there are no devices to clear.
 */
export function ResetDevicesButton({
  licenseId,
  deviceCount,
}: {
  licenseId: string;
  deviceCount: number;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not reset devices.");
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
        disabled={deviceCount === 0}
        title="Clear this license's device activations"
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-neutral-200 transition-colors hover:border-white/25 hover:bg-white/10 disabled:opacity-40 disabled:hover:border-white/12 disabled:hover:bg-white/[0.04]"
      >
        <i className="fa-solid fa-rotate-left text-[10px]" />
        Reset devices
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-right text-[11px] leading-tight text-neutral-300">
        Clear all {deviceCount} device{deviceCount === 1 ? "" : "s"}? They sign in
        again on next launch.
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/25 bg-white/15 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-white/25 disabled:opacity-60"
        >
          {busy ? (
            <i className="fa-solid fa-circle-notch animate-spin text-[10px]" />
          ) : (
            <i className="fa-solid fa-rotate-left text-[10px]" />
          )}
          Confirm reset
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
