"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";

/**
 * Self-serve account deletion. Two-step to avoid accidents: the first click
 * arms a confirm state; the second actually deletes, then signs the user out.
 */
export function DeleteAccountButton() {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not delete your account.");
      }
      await signOut({ callbackUrl: "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <div>
      {!armed ? (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/[0.06] px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:border-red-500/50 hover:bg-red-500/10"
        >
          <i className="fa-solid fa-trash text-xs" />
          Delete account
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-neutral-300">
            This permanently deletes your account, license and purchase history.
            Are you sure?
          </span>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl border border-red-500/50 bg-red-500/15 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/25 disabled:opacity-60"
          >
            {busy ? (
              <i className="fa-solid fa-circle-notch animate-spin text-xs" />
            ) : (
              <i className="fa-solid fa-trash text-xs" />
            )}
            Yes, delete everything
          </button>
          <button
            type="button"
            onClick={() => setArmed(false)}
            disabled={busy}
            className="rounded-xl px-3 py-2 text-sm text-neutral-400 transition-colors hover:text-white"
          >
            Cancel
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
