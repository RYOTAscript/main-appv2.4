"use client";

import { useState } from "react";
import type { Widget } from "@/data/widgets";
import { Toggle } from "@/components/ui/Toggle";

/**
 * A single mini-widget card in the library: icon tile, name, one-line
 * description, a category chip and an iOS toggle (for flavour — mirrors the
 * app's per-widget enable switch). Toggle state is local/visual only.
 */
export function WidgetCard({ widget }: { widget: Widget }) {
  const [enabled, setEnabled] = useState(false);
  const iconClass = `${widget.iconStyle === "fab" ? "fa-brands" : "fa-solid"} ${widget.icon}`;

  return (
    <div className="group glass flex h-full flex-col rounded-3xl border border-white/10 p-5 glow transition-[border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1 hover:border-accent/20 hover:shadow-[0_0_30px_rgba(var(--accent),0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-lg text-neutral-200 transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:scale-[1.12] group-hover:border-accent/40 group-hover:text-white">
          <i className={iconClass} />
        </div>
        <Toggle checked={enabled} onChange={setEnabled} />
      </div>

      <h3 className="mt-4 text-sm font-semibold tracking-tight text-white">
        {widget.name}
      </h3>
      <p className="mt-1.5 flex-1 text-xs leading-relaxed text-neutral-400">
        {widget.description}
      </p>

      <div className="mt-4 flex items-center justify-between">
        <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] font-medium tracking-wide text-neutral-300">
          {widget.category}
        </span>
        <span className="font-mono text-[10px] text-neutral-600">
          v{widget.version}
        </span>
      </div>
    </div>
  );
}
