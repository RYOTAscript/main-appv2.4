"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Logo } from "@/components/ui/Logo";

/**
 * Loadup animation for the hidden arcade (FooterLogoGame → SnakeGame).
 *
 * A glass boot terminal in the same visual language as the 404 page's route
 * trace: traffic-light dots, monospace command log, blinking caret. Lines
 * reveal in sequence with an accent "OK" chip landing right as each one
 * "completes"; a thin accent progress bar underneath is timed to finish
 * exactly as the last line lands. Click / Enter / Space skips straight to the
 * game. Respects prefers-reduced-motion (skips the sequence, short flat delay).
 */

const LINES = [
  "mount /dev/glass",
  "decrypt snake.core",
  "bind renderer -> accent",
  "prime input queue",
  "arcade ready",
] as const;

const PER_CHAR_MS = 12;
const MIN_LINE_MS = 190;
const GAP_MS = 90;
const INITIAL_DELAY_MS = 120;
const OK_LEAD_MS = 40; // OK chip lands this many ms before the line "completes"
const FINAL_HOLD_MS = 320;
const EXIT_MS = 220;
const SKIP_EXIT_MS = 160;
const REDUCED_MOTION_HOLD_MS = 260;

type Timeline = {
  revealAt: number;
  okAt: number | null; // last line has no OK chip — it *is* the final status
  completeAt: number;
}[];

function buildTimeline(): { steps: Timeline; barDoneAt: number; exitAt: number } {
  let t = INITIAL_DELAY_MS;
  const steps: Timeline = LINES.map((text, i) => {
    const dur = Math.max(MIN_LINE_MS, text.length * PER_CHAR_MS);
    const revealAt = t;
    const completeAt = revealAt + dur;
    const okAt = i < LINES.length - 1 ? completeAt - OK_LEAD_MS : null;
    t = completeAt + GAP_MS;
    return { revealAt, okAt, completeAt };
  });
  const barDoneAt = steps[steps.length - 1].completeAt;
  const exitAt = barDoneAt + FINAL_HOLD_MS;
  return { steps, barDoneAt, exitAt };
}

export function ArcadeBoot({ onDone }: { onDone: () => void }) {
  const timeline = useMemo(buildTimeline, []);
  const [revealed, setRevealed] = useState(0);
  const [okShown, setOkShown] = useState(0);
  const [barStarted, setBarStarted] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [instant, setInstant] = useState(false); // true once skipped — no transitions
  const timers = useRef<number[]>([]);
  const skippedRef = useRef(false);

  const clearTimers = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };

  useEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (reduced) {
      setRevealed(LINES.length);
      setOkShown(LINES.length - 1);
      setBarStarted(true);
      setInstant(true);
      const t = window.setTimeout(() => {
        setExiting(true);
        const t2 = window.setTimeout(onDone, 0);
        timers.current.push(t2);
      }, REDUCED_MOTION_HOLD_MS);
      timers.current.push(t);
      return clearTimers;
    }

    timeline.steps.forEach((step, i) => {
      const t1 = window.setTimeout(() => setRevealed((r) => Math.max(r, i + 1)), step.revealAt);
      timers.current.push(t1);
      if (step.okAt !== null) {
        const t2 = window.setTimeout(() => setOkShown((k) => Math.max(k, i + 1)), step.okAt);
        timers.current.push(t2);
      }
    });

    // Kick the bar transition on the next frame so the 0% start paints first.
    const raf = requestAnimationFrame(() => setBarStarted(true));

    const tExit = window.setTimeout(() => {
      if (skippedRef.current) return;
      setExiting(true);
      const tDone = window.setTimeout(onDone, EXIT_MS);
      timers.current.push(tDone);
    }, timeline.exitAt);
    timers.current.push(tExit);

    return () => {
      cancelAnimationFrame(raf);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skip = () => {
    if (skippedRef.current || exiting) return;
    skippedRef.current = true;
    clearTimers();
    setInstant(true);
    setRevealed(LINES.length);
    setOkShown(LINES.length - 1);
    setBarStarted(true);
    requestAnimationFrame(() => {
      setExiting(true);
      const t = window.setTimeout(onDone, SKIP_EXIT_MS);
      timers.current.push(t);
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inline `transition` shorthand (not `transitionDuration`) so that skipping
  // — where the target width doesn't actually change from "100%" — still
  // forces an instant jump instead of letting an in-flight transition glide
  // on at its original pace.
  const barTransition = instant ? "none" : `width ${timeline.barDoneAt}ms linear`;

  return (
    <div
      className={`ab-exit flex w-full max-w-md cursor-pointer flex-col items-center ${exiting ? "is-exiting" : ""}`}
      onClick={skip}
      role="button"
      tabIndex={0}
      aria-label="Skip loading"
    >
      {/* Power-on badge, same family as the 404 spin-ring but tighter. */}
      <div className="ab-icon relative mb-6">
        <div className="spin-ring flex h-16 w-16 items-center justify-center rounded-full border border-white/10">
          <div className="glass glow flex h-12 w-12 items-center justify-center rounded-full border border-white/10">
            <Logo size={26} rounded="rounded-lg" bordered={false} />
          </div>
        </div>
        <span className="live-dot absolute right-0 top-0" />
      </div>

      {/* Boot terminal — same vocabulary as the 404 route trace. */}
      <div className="glass glow w-full max-w-xs rounded-2xl border border-white/10 p-4 text-left font-mono text-xs leading-relaxed">
        <div className="mb-2.5 flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-2 text-[10px] tracking-wide text-neutral-600">
            main · arcade
          </span>
        </div>

        <div className="min-h-[7.5em]">
          {LINES.map((text, i) => {
            const isLast = i === LINES.length - 1;
            const shown = revealed > i;
            const okDone = okShown > i;
            const isCurrent = revealed === i + 1 && !isLast;
            return (
              <p
                key={text}
                className={`ab-line flex items-center gap-2 ${shown ? "is-shown" : ""} ${
                  isLast ? "mt-0.5 text-accent-solid" : "text-neutral-400"
                }`}
              >
                <span className={isLast ? "text-accent-solid" : "text-neutral-600"}>
                  {isLast ? "✓" : "$"}
                </span>
                <span>{text}</span>
                {isCurrent && <span className="nf-caret" aria-hidden />}
                {!isLast && (
                  <span
                    className={`ab-ok ml-auto text-accent-solid ${okDone ? "is-shown" : ""}`}
                  >
                    OK
                  </span>
                )}
              </p>
            );
          })}
        </div>

        <div className="ab-bar-track mt-3">
          <div
            className="ab-bar-fill"
            style={{
              width: barStarted ? "100%" : "0%",
              transition: barTransition,
            }}
          />
        </div>
      </div>

      <p className="mt-5 font-mono text-[10px] tracking-wide text-neutral-600">
        click, Enter, or Space to skip
      </p>
    </div>
  );
}
