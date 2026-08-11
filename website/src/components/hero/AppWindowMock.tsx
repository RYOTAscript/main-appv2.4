"use client";

import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/ui/Logo";
import { VERSION_LABEL } from "@/lib/site";
import { cn } from "@/lib/cn";

/**
 * Pixel-faithful, lightly-animated replica of the real "main" window
 * (main-app11/main-app/main.html), rendered at the app's native 920×640 and
 * scaled to fit by <ScaledStage>. It assembles on load (header → Quick Launch
 * → widget cards → strip) and stays alive after: CPU/RAM bars breathe, the
 * vinyl disk spins with a beat-pulsing glow, the progress bar creeps, and the
 * "live" dot pulses.
 */

const QUICK_LAUNCH = [
  { icon: "fa-brands fa-steam", label: "Steam" },
  { icon: "fa-brands fa-discord", label: "Discord" },
  { icon: "fa-brands fa-chrome", label: "Chrome" },
  { icon: "fa-brands fa-spotify", label: "Spotify" },
  { icon: "fa-solid fa-folder", label: "Files" },
  { icon: "fa-solid fa-gamepad", label: "Games" },
];

const STRIP = [
  { icon: "fa-solid fa-microphone", label: "Mic Mute" },
  { icon: "fa-solid fa-crosshairs", label: "Crosshair" },
  { icon: "fa-solid fa-clipboard", label: "Clipboard" },
  { icon: "fa-solid fa-hourglass-half", label: "Timer" },
  { icon: "fa-solid fa-sliders", label: "Volume Mixer" },
];

/**
 * Quick Notes widget that "writes itself". At rest it shows a dim
 * "start typing here…" placeholder; the first time it scrolls into view it
 * clears and types a short note out character-by-character with a live caret
 * (human-ish timing — longer pauses after line breaks). Types once, then the
 * caret settles into a slow blink. Honours prefers-reduced-motion by showing
 * the finished note instantly.
 */
const NOTE_LINES = [
  "— grab milk & coffee",
  "— reply to Alex",
  "— gym at 7",
];
const NOTE_TEXT = NOTE_LINES.join("\n");

function QuickNotes() {
  const ref = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState("");
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let timer: ReturnType<typeof setTimeout>;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        io.disconnect();
        setStarted(true);
        if (reduced) {
          setTyped(NOTE_TEXT);
          return;
        }
        let i = 0;
        const tick = () => {
          i += 1;
          setTyped(NOTE_TEXT.slice(0, i));
          if (i >= NOTE_TEXT.length) return;
          const prev = NOTE_TEXT[i - 1];
          // Pause a beat after newlines, breeze through spaces, otherwise a
          // slightly random keystroke cadence so it reads as a real hand.
          const delay =
            prev === "\n" ? 430 : prev === " " ? 68 : 40 + Math.random() * 54;
          timer = setTimeout(tick, delay);
        };
        timer = setTimeout(tick, 520);
      },
      { threshold: 0.55 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
  }, []);

  const lines = typed.split("\n");
  const done = typed.length === NOTE_TEXT.length;

  return (
    <div
      ref={ref}
      className="mock-item glass relative h-52 overflow-hidden rounded-3xl border border-white/10 p-5 glow"
      style={{ animationDelay: "0.24s" }}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="section-label">Quick Notes</h3>
        <i className="fa-solid fa-pen-nib text-[10px] text-neutral-600" />
      </div>

      {!started ? (
        <p className="text-sm italic text-neutral-600">start typing here…</p>
      ) : (
        <p className="text-sm leading-relaxed text-neutral-300">
          {lines.map((line, i) => {
            const isLast = i === lines.length - 1;
            return (
              <span key={i}>
                {line}
                {isLast && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] bg-white/70",
                      done && "animate-pulse",
                    )}
                  />
                )}
                {!isLast && <br />}
              </span>
            );
          })}
        </p>
      )}
    </div>
  );
}

export function AppWindowMock() {
  const [cpu, setCpu] = useState(28);
  const [ram, setRam] = useState(54);
  const [progress, setProgress] = useState(32);

  // Living stats: nudge CPU/RAM around real-feeling values; the CSS width
  // transition (1.2s ease) makes each change glide.
  useEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) return;

    const id = setInterval(() => {
      setCpu(() => 18 + Math.round(Math.random() * 34));
      setRam(() => 46 + Math.round(Math.random() * 22));
    }, 2200);
    return () => clearInterval(id);
  }, []);

  // Progress bar creeps forward and loops.
  useEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) return;

    const id = setInterval(() => {
      setProgress((p) => (p >= 100 ? 0 : p + 1));
    }, 900);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className="app-mock glow-strong relative h-[640px] w-[920px] overflow-hidden rounded-[32px] border border-white/10"
      role="img"
      aria-label="A preview of the main desktop overlay window"
    >
      {/* Local background layers (a self-contained version of the FX stack) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="bg-scene" />
        <div className="bg-blob bg-blob-a" />
        <div className="bg-blob bg-blob-b" />
        <div className="grid-overlay" />
        <div className="scanline" />
      </div>

      <div className="relative z-10 flex h-full flex-col">
        {/* ── Header ── */}
        <div
          className="mock-item flex select-none items-center justify-between border-b border-white/10 px-8 py-5"
          style={{ animationDelay: "0s" }}
        >
          <div className="flex items-center gap-3">
            <Logo size={36} />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-white">
                main
              </h1>
              <p className="text-[10px] tracking-widest text-neutral-500">
                {VERSION_LABEL}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <div className="mr-2 flex items-center gap-2 font-mono text-sm tabular-nums text-neutral-400">
              <i className="fa-solid fa-cloud-sun text-neutral-500" />
              <span>18°C</span>
            </div>
            <div className="mr-1 font-mono text-sm tabular-nums text-neutral-400">
              9:41 <span className="text-neutral-600">PM</span>
            </div>
            <span className="window-btn">
              <i className="fas fa-cog text-xs" />
            </span>
            <span className="window-btn">
              <i className="fas fa-minus text-xs" />
            </span>
          </div>
        </div>

        {/* ── Quick Launch ── */}
        <div
          className="mock-item px-8 pt-8"
          style={{ animationDelay: "0.08s" }}
        >
          <h2 className="section-label mb-5">Quick Launch</h2>
          <div className="grid grid-cols-6 gap-6">
            {QUICK_LAUNCH.map((app) => (
              <div
                key={app.label}
                className="launch-tile flex cursor-pointer flex-col items-center gap-2"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-neutral-950 text-xl text-neutral-300">
                  <i className={app.icon} />
                </div>
                <span className="text-[10px] text-neutral-500">
                  {app.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Widgets row ── */}
        <div className="mt-10 grid grid-cols-3 gap-5 px-8">
          {/* Quick Notes — types itself when scrolled into view. */}
          <QuickNotes />

          {/* Performance */}
          <div
            className="mock-item glass h-52 rounded-3xl border border-white/10 p-5 glow"
            style={{ animationDelay: "0.32s" }}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="section-label">Performance</h3>
              <div className="flex items-center gap-1.5 font-mono text-[10px] text-neutral-500">
                <span className="live-dot" />
                <span>live</span>
              </div>
            </div>
            <div className="space-y-5 text-sm">
              <div>
                <div className="mb-1.5 flex justify-between">
                  <span className="text-neutral-500">CPU</span>
                  <span className="font-mono text-xs text-white">{cpu}%</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className="stat-bar h-full rounded-full"
                    style={{ width: `${cpu}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex justify-between">
                  <span className="text-neutral-500">RAM</span>
                  <span className="font-mono text-xs text-neutral-300">
                    {ram}%
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className="stat-bar h-full rounded-full opacity-80"
                    style={{ width: `${ram}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Spotify */}
          <div
            className="mock-item glass relative flex h-52 flex-col items-center justify-center overflow-hidden rounded-3xl border border-white/10 p-5 text-center glow"
            style={{ animationDelay: "0.4s" }}
          >
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.03] to-transparent" />
            <div className="relative z-10 flex flex-col items-center">
              <div className="relative flex h-24 w-24 items-center justify-center">
                <div className="beat-halo" />
                <div className="vinyl-disk relative flex h-20 w-20 animate-spin-slow items-center justify-center rounded-full bg-neutral-900">
                  <i className="fa-brands fa-spotify text-3xl text-neutral-400" />
                  <span className="absolute h-2.5 w-2.5 rounded-full bg-neutral-950 ring-1 ring-white/10" />
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2.5">
                <span className="flex h-6 w-6 items-center justify-center text-neutral-400">
                  <i className="fas fa-step-backward text-[9px]" />
                </span>
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white">
                  <i className="fas fa-pause text-[9px]" />
                </span>
                <span className="flex h-6 w-6 items-center justify-center text-neutral-400">
                  <i className="fas fa-step-forward text-[9px]" />
                </span>
              </div>
              <div className="mt-1.5 w-full px-3">
                <div className="mb-0.5 flex justify-between font-mono text-[8px] text-neutral-500">
                  <span>1:12</span>
                  <span>3:48</span>
                </div>
                <div className="progress-track h-1">
                  <div
                    className="progress-fill"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Mini Widgets strip ── */}
        <div
          className="mock-item mt-5 px-8"
          style={{ animationDelay: "0.46s" }}
        >
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="section-label">Mini Widgets</h2>
            <span className="mock-chip">
              <i className="fas fa-shapes text-[10px]" />
              Browse Widgets
            </span>
          </div>
          <div className="flex gap-2 overflow-hidden">
            {STRIP.map((w) => (
              <span key={w.label} className="mock-chip">
                <i className={`${w.icon} text-[10px] text-neutral-400`} />
                {w.label}
              </span>
            ))}
          </div>
        </div>

        {/* ── Footer ── */}
        <div
          className="mock-item absolute inset-x-8 bottom-5 flex justify-between text-[10px] tracking-wide text-neutral-600"
          style={{ animationDelay: "0.5s" }}
        >
          <div className="font-mono">Alt+M focus · Alt+Q close</div>
          <div className="font-mono">
            <span className="text-neutral-700">made by ryota</span> · {VERSION_LABEL}
          </div>
        </div>
      </div>
    </div>
  );
}
