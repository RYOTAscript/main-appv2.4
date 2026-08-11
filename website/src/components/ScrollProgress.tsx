"use client";

import { useEffect, useRef } from "react";

/**
 * Thin accent bar pinned to the very top edge that fills as you read down the
 * page. Written to a CSS scaleX (transform-only, so it never triggers layout)
 * via rAF, so it stays smooth even on long pages.
 */
export function ScrollProgress() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const p = max > 0 ? Math.min(1, doc.scrollTop / max) : 0;
      el.style.transform = `scaleX(${p})`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 origin-left"
      style={{
        transform: "scaleX(0)",
        background: "var(--accent-solid)",
        boxShadow: "0 0 8px rgba(var(--accent), 0.6)",
      }}
      ref={ref}
    />
  );
}
