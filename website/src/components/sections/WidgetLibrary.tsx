"use client";

import { useMemo, useState } from "react";
import { WIDGETS, WIDGET_CATEGORIES } from "@/data/widgets";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { ScrollReveal } from "@/components/ScrollReveal";
import { WidgetCard } from "@/components/WidgetCard";
import { cn } from "@/lib/cn";

const ALL = "All";

const PREVIEW_COUNT = 6;

export function WidgetLibrary() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ALL);
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return WIDGETS.filter((w) => {
      if (category !== ALL && w.category !== category) return false;
      if (!q) return true;
      const haystack = [
        w.name,
        w.description,
        w.category,
        ...w.keywords,
        ...w.features,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [query, category]);

  const chips = [ALL, ...WIDGET_CATEGORIES];

  // When browsing (no search, "All" category), collapse to a preview so the
  // page isn't a wall of cards; a search or category filter shows every match.
  const isBrowsing = !query.trim() && category === ALL;
  const collapsed = isBrowsing && !showAll;
  const visible = collapsed ? filtered.slice(0, PREVIEW_COUNT) : filtered;
  const hiddenCount = filtered.length - visible.length;

  return (
    <section
      id="widgets"
      className="relative mx-auto max-w-6xl px-6 py-24 scroll-mt-24"
    >
      <ScrollReveal className="mb-10 text-center">
        <SectionLabel className="mb-4">Widget Library</SectionLabel>
        <h2 className="display-type mx-auto max-w-2xl text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
          19 mini widgets. All included.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-balance text-neutral-400">
          Browse the same library that lives inside the app — search it, filter
          by category, and flip any one on.
        </p>
      </ScrollReveal>

      {/* Search + count */}
      <ScrollReveal delay={0.06} className="mb-4">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <div className="relative flex-1">
            <i className="fa-solid fa-magnifying-glass pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-neutral-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search widgets…"
              aria-label="Search widgets"
              className="w-full rounded-xl border border-white/10 bg-neutral-900/70 py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-neutral-500 focus:border-accent/40 focus:outline-none"
            />
          </div>
          <span className="hidden font-mono text-xs text-neutral-500 sm:inline">
            {filtered.length} / {WIDGETS.length}
          </span>
        </div>
      </ScrollReveal>

      {/* Category chips */}
      <ScrollReveal delay={0.1} className="mb-8">
        <div className="flex flex-wrap justify-center gap-2">
          {chips.map((chip) => {
            const active = category === chip;
            return (
              <button
                key={chip}
                type="button"
                onClick={() => setCategory(chip)}
                aria-pressed={active}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-xs font-medium transition-all duration-200",
                  active
                    ? "border-accent/50 bg-white/10 text-white shadow-[0_0_16px_rgba(var(--accent),0.12)]"
                    : "border-white/10 bg-white/[0.03] text-neutral-400 hover:border-white/25 hover:text-white",
                )}
              >
                {chip}
              </button>
            );
          })}
        </div>
      </ScrollReveal>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center">
          <i className="fa-solid fa-magnifying-glass mb-3 inline-block text-xl text-neutral-700" />
          <p className="text-sm text-neutral-500">
            No widgets match your search.
          </p>
          <p className="mt-1 text-[11px] text-neutral-600">
            Try a different term, or pick another category.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((widget, i) => (
              <ScrollReveal
                key={widget.id}
                delay={(i % 3) * 0.06}
                className="h-full"
              >
                <WidgetCard widget={widget} />
              </ScrollReveal>
            ))}
          </div>

          {/* Expand / collapse — keeps the section short while browsing */}
          {isBrowsing && filtered.length > PREVIEW_COUNT && (
            <div className="relative mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-neutral-200 transition-all duration-200 hover:border-accent/30 hover:bg-white/10 hover:text-white"
              >
                {collapsed ? (
                  <>
                    Show all {filtered.length} widgets
                    <span className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                      +{hiddenCount}
                    </span>
                    <i className="fa-solid fa-chevron-down text-[10px]" />
                  </>
                ) : (
                  <>
                    Show less
                    <i className="fa-solid fa-chevron-up text-[10px]" />
                  </>
                )}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
