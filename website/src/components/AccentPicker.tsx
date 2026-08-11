"use client";

import { useAccent } from "@/components/AccentProvider";
import { cn } from "@/lib/cn";

/** Row of accent swatches that live-re-tint the whole site (app parity). */
export function AccentPicker({ className }: { className?: string }) {
  const { accent, setAccentId, accents } = useAccent();

  return (
    <div
      className={cn("flex items-center gap-2.5", className)}
      role="radiogroup"
      aria-label="Accent theme"
    >
      {accents.map((a) => {
        const selected = a.id === accent.id;
        return (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={a.label}
            title={a.label}
            onClick={() => setAccentId(a.id)}
            className={cn(
              "relative h-6 w-6 rounded-full border border-white/20",
              "transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-110",
              selected &&
                "shadow-[0_0_0_2px_#0a0a0a,0_0_0_3.5px_rgba(255,255,255,0.9),0_0_14px_rgba(255,255,255,0.18)]",
            )}
            style={{ background: a.solid }}
          />
        );
      })}
    </div>
  );
}
