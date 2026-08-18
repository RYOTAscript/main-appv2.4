"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/ui/Logo";
import { ArcadeBoot } from "@/components/ArcadeBoot";
import { SnakeGame } from "@/components/SnakeGame";

/**
 * Footer easter egg: the "main" logo mark opens the hidden glass arcade.
 *
 * Deliberately a client-side modal, not a route. A dedicated /play page 404s
 * intermittently under the Next 14 dev server (new App Router segments get
 * dropped from the manifest on HMR recompiles), so opening the game as an
 * overlay from the already-loaded bundle is bulletproof in both dev and prod —
 * no navigation, no RSC fetch, nothing to 404.
 */
export function FooterLogoGame() {
  const [open, setOpen] = useState(false);
  // Boot sequence plays every time the arcade opens; ArcadeBoot flips this
  // via onDone once its terminal log + progress bar finish (or are skipped).
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBooted(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    // Lock background scroll while the arcade is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Play a hidden game"
        title="Play"
        className="rounded-2xl transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-0.5 hover:drop-shadow-[0_0_12px_rgba(var(--accent),0.35)] active:scale-95"
      >
        <Logo size={36} />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-md sm:items-center"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="2048 arcade"
        >
          <div
            className="relative my-auto w-full max-w-md py-10"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="absolute right-0 top-2 inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/12 bg-white/[0.06] text-neutral-300 transition-colors hover:border-white/25 hover:bg-white/12 hover:text-white"
            >
              <i className="fa-solid fa-xmark" />
            </button>
            {booted ? (
              <SnakeGame />
            ) : (
              <ArcadeBoot onDone={() => setBooted(true)} />
            )}
          </div>
        </div>
      )}
    </>
  );
}
