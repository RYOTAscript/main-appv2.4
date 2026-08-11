"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Floating "jump to top" control that fades/scales in once you've scrolled a
 * screenful or so. Hidden from assistive tech until it's actually usable.
 */
export function BackToTop() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > 700);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      aria-label="Back to top"
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      onClick={() =>
        window.scrollTo({
          top: 0,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        })
      }
      className={cn(
        "glass fixed bottom-6 right-6 z-50 flex h-11 w-11 items-center justify-center rounded-full",
        "border border-white/15 text-neutral-200 shadow-[0_8px_28px_rgba(0,0,0,0.5)]",
        "transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        "hover:border-accent/40 hover:text-white hover:shadow-[0_0_24px_rgba(var(--accent),0.18)]",
        "active:scale-95",
        shown
          ? "translate-y-0 scale-100 opacity-100"
          : "pointer-events-none translate-y-3 scale-90 opacity-0",
      )}
    >
      <i className="fa-solid fa-arrow-up text-sm" />
    </button>
  );
}
