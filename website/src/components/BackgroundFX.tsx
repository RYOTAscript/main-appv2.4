"use client";

import { useEffect, useRef } from "react";

/**
 * The app's animated "Background Studio" stack, rendered as a fixed,
 * pointer-events-none layer behind all content:
 *   bg-scene (radial light pools) → 3 drifting blobs → grid → scanlines →
 *   vignette → film grain.
 * A light pointer parallax drifts the whole layer away from the cursor.
 * All motion is disabled under prefers-reduced-motion (handled in globals.css)
 * and the parallax listener bails on touch / reduced-motion devices.
 */
export function BackgroundFX() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (reduced || coarse) return;

    let raf = 0;
    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;

    const onMove = (e: PointerEvent) => {
      const nx = e.clientX / window.innerWidth - 0.5;
      const ny = e.clientY / window.innerHeight - 0.5;
      // Background drifts AWAY from the cursor (negative), subtly.
      tx = -nx * 18;
      ty = -ny * 18;
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const tick = () => {
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      el.style.transform = `translate3d(${cx.toFixed(2)}px, ${cy.toFixed(2)}px, 0)`;
      if (Math.abs(tx - cx) > 0.1 || Math.abs(ty - cy) > 0.1) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="bg-fx" aria-hidden="true">
      {/* The parallax-driven far layer; bleeds past edges so the drift never
          reveals a bare strip. */}
      <div ref={rootRef} className="absolute -inset-24 will-change-transform">
        <div className="bg-scene" />
        <div className="bg-blob bg-blob-a" />
        <div className="bg-blob bg-blob-b" />
        <div className="bg-blob bg-blob-c" />
      </div>
      <div className="grid-overlay" />
      <div className="scanline" />
      <div className="vignette" />
      <div className="grain" />
    </div>
  );
}
