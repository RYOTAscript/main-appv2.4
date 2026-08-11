"use client";

import { useState } from "react";

/**
 * PayPal checkout via the REDIRECT flow (not the embedded SDK iframe). Our own
 * dark, on-brand button creates the order server-side, then sends the buyer to
 * PayPal's hosted approval page. PayPal returns them to /api/paypal/return,
 * which captures + provisions. No PayPal iframe on our page, so nothing flashes
 * white and the button matches the site exactly.
 */
export function PayPalCheckout() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pay = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/paypal/create-order", { method: "POST" });
      const data = (await res.json()) as { approveUrl?: string; error?: string };
      if (!res.ok || !data.approveUrl) {
        throw new Error(data.error || "Could not start checkout.");
      }
      // Hand off to PayPal's hosted approval page.
      window.location.href = data.approveUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={pay}
        disabled={loading}
        className="inline-flex w-full items-center justify-center gap-2.5 rounded-2xl border border-white/12 bg-white/[0.06] px-6 py-3.5 text-base font-medium text-white transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:border-accent/30 hover:bg-white/[0.12] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60"
      >
        {loading ? (
          <>
            <i className="fa-solid fa-circle-notch animate-spin text-sm" />
            Redirecting to PayPal…
          </>
        ) : (
          <>
            <i className="fa-brands fa-paypal text-base text-[#a5b4fc]" />
            Pay with PayPal — $5
          </>
        )}
      </button>
      <p className="mt-2 text-center text-[11px] text-neutral-500">
        <i className="fa-solid fa-lock mr-1 text-[9px]" />
        You&apos;ll finish securely on PayPal — pay with your balance or any card.
      </p>
      {error && <p className="mt-2 text-center text-xs text-red-400">{error}</p>}
    </div>
  );
}
