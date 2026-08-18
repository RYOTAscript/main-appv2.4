"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { VERSION_LABEL } from "@/lib/site";

/**
 * Interactive glass 404. Lives inside the root layout (nav + footer + animated
 * background). Themed as a "missing widget" from the library:
 *   • cursor-parallax spotlight + a glitchy chromatic-aberration "404"
 *   • drifting ghost chips of real widgets that "fell off the glass"
 *   • a live terminal trace that resolves the actual bad route to a 404
 * Every effect no-ops under prefers-reduced-motion (see globals.css .nf-*).
 */

// The widgets that "drifted off" — pulled from the real library vocabulary.
const GHOST_WIDGETS = [
  { icon: "fa-brands fa-spotify", label: "Spotify" },
  { icon: "fa-solid fa-gauge-high", label: "FPS Optimizer" },
  { icon: "fa-solid fa-rocket", label: "Quick Launch" },
  { icon: "fa-solid fa-microchip", label: "System Monitor" },
  { icon: "fa-solid fa-download", label: "App Installer" },
  { icon: "fa-solid fa-broom", label: "Debloat" },
] as const;

// Deterministic per-chip drift so SSR and client markup match (no hydration
// mismatch) while still looking scattered.
const GHOST_LAYOUT = [
  { top: "12%", left: "8%", dx: "26px", dy: "-22px", rot: "-6deg", dur: "13s" },
  { top: "22%", left: "82%", dx: "-30px", dy: "20px", rot: "5deg", dur: "16s" },
  { top: "70%", left: "12%", dx: "22px", dy: "18px", rot: "7deg", dur: "15s" },
  { top: "78%", left: "76%", dx: "-24px", dy: "-20px", rot: "-5deg", dur: "12s" },
  { top: "44%", left: "3%", dx: "18px", dy: "-16px", rot: "4deg", dur: "17s" },
  { top: "52%", left: "90%", dx: "-20px", dy: "16px", rot: "-7deg", dur: "14s" },
] as const;

export function NotFoundScene() {
  const rawPath = usePathname();
  const path = rawPath && rawPath !== "/" ? rawPath : "/unknown-widget";
  const sceneRef = useRef<HTMLDivElement>(null);

  // Cursor parallax → CSS vars on the scene. rAF-throttled; skipped entirely
  // for users who prefer reduced motion.
  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let px = 0;
    let py = 0;
    const onMove = (e: PointerEvent) => {
      // Viewport-relative so the fixed, full-screen spotlight lands under the
      // cursor exactly (the section is only max-w wide — mapping to it would
      // squeeze the glow into the centre column).
      px = e.clientX / window.innerWidth; // 0..1
      py = e.clientY / window.innerHeight;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        el.style.setProperty("--nf-mx", (px * 2 - 1).toFixed(3));
        el.style.setProperty("--nf-my", (py * 2 - 1).toFixed(3));
        el.style.setProperty("--nf-gx", `${(px * 100).toFixed(1)}%`);
        el.style.setProperty("--nf-gy", `${(py * 100).toFixed(1)}%`);
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section
      ref={sceneRef}
      className="nf-scene relative mx-auto flex min-h-[86vh] max-w-4xl flex-col items-center justify-center px-6 pt-28 pb-16 text-center"
    >
      {/* Cursor-tracking accent spotlight */}
      <div className="nf-spotlight" aria-hidden />

      {/* Drifting ghost widgets that "fell off the glass" */}
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden>
        {GHOST_WIDGETS.map((w, i) => {
          const g = GHOST_LAYOUT[i];
          return (
            <div
              key={w.label}
              className="nf-ghost absolute"
              style={
                {
                  top: g.top,
                  left: g.left,
                  "--nf-dx": g.dx,
                  "--nf-dy": g.dy,
                  "--nf-rot": g.rot,
                  "--nf-dur": g.dur,
                } as React.CSSProperties
              }
            >
              <span className="glass inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-1.5 text-xs text-neutral-500 opacity-50">
                <i className={`${w.icon} text-[11px] opacity-70`} />
                {w.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Foreground content */}
      <div className="relative z-10 flex flex-col items-center">
        {/* Spinning-ring badge with the app logo + offline dot */}
        <div className="relative mb-9">
          <div className="spin-ring flex h-28 w-28 items-center justify-center rounded-full border border-white/10">
            <div className="glass flex h-24 w-24 items-center justify-center rounded-full border border-white/10 glow-strong">
              <Logo size={56} rounded="rounded-2xl" bordered={false} />
            </div>
          </div>
          <span className="live-dot absolute right-1 top-1" />
        </div>

        <SectionLabel className="mb-4">Error 404 · widget not found</SectionLabel>

        {/* Glitchy chromatic 404 with cursor parallax */}
        <div className="nf-glitch group cursor-default select-none">
          <span
            className="nf-glitch__layer nf-glitch__layer--a display-type text-8xl font-bold tracking-tight sm:text-[10rem]"
            aria-hidden
          >
            404
          </span>
          <span
            className="nf-glitch__layer nf-glitch__layer--b display-type text-8xl font-bold tracking-tight sm:text-[10rem]"
            aria-hidden
          >
            404
          </span>
          <span
            className="display-type relative block text-8xl font-bold tracking-tight text-white sm:text-[10rem]"
            style={{ textShadow: "0 0 44px rgba(var(--accent), 0.28)" }}
          >
            404
          </span>
        </div>

        <p className="mt-6 max-w-md text-balance text-lg text-neutral-400">
          This widget isn&apos;t in the library. The page you were looking for
          drifted off the glass — or never existed.
        </p>

        {/* Live route-resolution "terminal" trace */}
        <div className="glass mt-8 w-full max-w-md rounded-2xl border border-white/10 p-4 text-left font-mono text-xs leading-relaxed glow">
          <div className="mb-2.5 flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-2 text-[10px] tracking-wide text-neutral-600">
              main · router
            </span>
          </div>
          <p className="text-neutral-400">
            <span className="text-accent-solid">$</span> resolve{" "}
            <span className="text-neutral-200">{path}</span>
          </p>
          <p className="mt-1 text-[#ff6b8a]">
            <i className="fa-solid fa-xmark mr-1.5" />
            404 · no matching route in registry
          </p>
          <p className="mt-1 text-neutral-500">
            <i className="fa-solid fa-arrow-turn-down mr-1.5 rotate-90" />
            nearest match{" "}
            <a
              href="/#widgets"
              className="text-neutral-300 underline decoration-white/20 underline-offset-2 transition-colors hover:text-white hover:decoration-white/60"
            >
              /#widgets
            </a>
            <span className="nf-caret align-middle" aria-hidden />
          </p>
        </div>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Button href="/" variant="primary" size="lg">
            <i className="fa-solid fa-house text-xs" />
            Back home
          </Button>
          <Button href="/#widgets" variant="secondary" size="lg">
            Browse widgets
            <i className="fa-solid fa-arrow-right text-xs" />
          </Button>
        </div>

        <p className="mt-10 font-mono text-xs tracking-wide text-neutral-600">
          <span className="text-neutral-700">main</span> · {VERSION_LABEL} · route
          not found
        </p>
      </div>
    </section>
  );
}
