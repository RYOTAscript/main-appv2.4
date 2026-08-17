"use client";

import { useEffect, useRef, useState } from "react";
import { ScaledStage } from "@/components/hero/ScaledStage";
import {
  AppWindowMock,
  type WidgetVisibility,
} from "@/components/hero/AppWindowMock";
import { cn } from "@/lib/cn";

/**
 * The hero centerpiece: the floating, scaled app-window mock plus a live
 * "customize this preview" toolbar. Toggling a widget reconfigures the mock in
 * place — the same modular, pick-your-widgets story the product sells, made
 * touchable right on the landing page. The toolbar renders at full scale
 * (outside <ScaledStage>) so it stays crisp and clickable.
 */

const TOGGLES: {
  key: keyof WidgetVisibility;
  label: string;
  icon: string;
}[] = [
  { key: "notes", label: "Quick Notes", icon: "fa-solid fa-pen-nib" },
  { key: "performance", label: "Performance", icon: "fa-solid fa-gauge-high" },
  { key: "spotify", label: "Spotify", icon: "fa-brands fa-spotify" },
  { key: "lyrics", label: "Lyrics", icon: "fa-solid fa-align-left" },
];

export function HeroApp() {
  // Default to the wide, spacious Spotify view — the way the real app looks with
  // the music widget front-and-centre (readable lyrics, turntable, visualiser).
  // Visitors can add Quick Notes / Performance back from the toolbar.
  const [visible, setVisible] = useState<WidgetVisibility>({
    notes: false,
    performance: false,
    spotify: true,
    lyrics: true,
  });

  const toggle = (key: keyof WidgetVisibility) =>
    setVisible((v) => ({ ...v, [key]: !v[key] }));

  // Pause the whole hero mock (its playback clock, the spinning vinyl, beat
  // glow, and the idle float) while it's scrolled off-screen. The mock lives at
  // the top of the page, so this stops it repainting its blurred glass cards
  // every frame while the visitor reads the rest of the page — the main source
  // of scroll jank once the hero is out of view.
  const floatRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(true);

  useEffect(() => {
    const el = floatRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => setActive(!!entries[0]?.isIntersecting),
      { rootMargin: "120px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="w-full">
      {/* max-md:overflow-x-clip: the mock is laid out at a fixed 920px and only
          visually shrunk via transform:scale, and the spotlight bleeds past the
          edges — both overflow a phone viewport. Clip that horizontal overflow
          on mobile (clip, not hidden, so it adds no scroll container); desktop
          keeps the full ambient glow. */}
      <div className="relative w-full max-md:overflow-x-clip">
        {/* Spotlight + floor glow behind the window */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-10 -top-10 bottom-0 -z-10"
        >
          <div className="absolute left-1/2 top-0 h-[60%] w-[80%] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(var(--accent),0.10),transparent_70%)] blur-2xl" />
          <div className="absolute bottom-4 left-1/2 h-24 w-[70%] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(var(--accent),0.12),transparent_70%)] blur-2xl" />
        </div>
        <div
          ref={floatRef}
          className={cn(
            "hero-float mx-auto w-full max-w-[960px]",
            !active && "is-paused",
          )}
        >
          <ScaledStage baseWidth={920} baseHeight={640} className="w-full">
            <AppWindowMock visible={visible} active={active} />
          </ScaledStage>
        </div>
      </div>

      {/* ── Customize toolbar ── */}
      <div className="mt-6 flex flex-col items-center gap-3">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-neutral-500">
          <i className="fa-solid fa-wand-magic-sparkles text-[10px] text-accent" />
          Customize this preview
        </div>
        <div className="preview-toolbar flex flex-wrap items-center justify-center gap-2">
          {TOGGLES.map((t) => {
            const on = visible[t.key];
            // Lyrics render inside the Spotify card, so the toggle only bites
            // while Spotify is shown — exactly like the app's Settings.
            const disabled = t.key === "lyrics" && !visible.spotify;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => toggle(t.key)}
                aria-pressed={on}
                disabled={disabled}
                title={
                  disabled ? "Turn on Spotify to show lyrics" : undefined
                }
                className={cn(
                  "preview-toggle",
                  on && "preview-toggle--on",
                  disabled && "preview-toggle--disabled",
                )}
              >
                <i className={cn(t.icon, "text-[11px]")} />
                <span>{t.label}</span>
                <span className="preview-toggle__dot" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
