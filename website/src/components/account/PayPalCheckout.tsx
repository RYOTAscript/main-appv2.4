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
  const [consent, setConsent] = useState(false);

  const pay = async () => {
    if (!consent) {
      setError("Please tick the box to continue.");
      return;
    }
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
      <label className="mb-3 flex cursor-pointer items-start gap-2.5 text-left text-[11px] leading-relaxed text-neutral-400">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => {
            setConsent(e.target.checked);
            if (e.target.checked) setError(null);
          }}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[rgb(var(--accent))]"
        />
        <span>
          I agree that my download and license key are made available
          immediately, and I understand I therefore lose my 14-day right of
          withdrawal. See the{" "}
          <a href="/terms" className="text-neutral-300 underline hover:text-white">
            Terms
          </a>
          .
        </span>
      </label>
      <button
        type="button"
        onClick={pay}
        disabled={loading || !consent}
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
