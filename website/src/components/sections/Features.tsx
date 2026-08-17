import { FEATURES, type Feature } from "@/data/features";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { ScrollReveal } from "@/components/ScrollReveal";
import { HotkeyPill } from "@/components/ui/HotkeyPill";
import { cn } from "@/lib/cn";

function FeatureCard({ feature }: { feature: Feature }) {
  const iconClass = `${feature.iconStyle === "fab" ? "fa-brands" : "fa-solid"} ${feature.icon}`;
  return (
    <div
      className={cn(
        "group glass relative flex h-full flex-col rounded-3xl border border-white/10 p-6 glow",
        "transition-[border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        "hover:-translate-y-1 hover:border-accent/20 hover:shadow-[0_0_30px_rgba(var(--accent),0.08)]",
        feature.span && "lg:col-span-2",
      )}
    >
      <div
        className={cn(
          "mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-xl text-neutral-200",
          "transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          "group-hover:-translate-y-1 group-hover:scale-[1.12] group-hover:border-accent/40 group-hover:text-white",
        )}
      >
        <i className={iconClass} />
      </div>

      <h3 className="text-lg font-semibold tracking-tight text-white">
        {feature.title}
      </h3>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-neutral-400">
        {feature.description}
      </p>

      {feature.hotkeys && (
        <div className="mt-4 flex flex-wrap gap-2">
          {feature.hotkeys.map((hk) => (
            <HotkeyPill key={hk} combo={hk} />
          ))}
        </div>
      )}

      {feature.tags && (
        <div className="mt-4 flex flex-wrap gap-2">
          {feature.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-[10px] tracking-wide text-neutral-400"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Features() {
  return (
    <section id="features" className="relative mx-auto max-w-6xl px-6 pb-24 pt-12">
      <ScrollReveal className="mb-12 text-center">
        <SectionLabel className="mb-4">Features</SectionLabel>
        <h2 className="display-type mx-auto max-w-2xl text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
          Everything you tab out for, in one glass panel.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-balance text-neutral-400">
          The core toolkit that ships with main — always on top, always themed
          to your accent.
        </p>
      </ScrollReveal>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature, i) => (
          <ScrollReveal
            key={feature.id}
            delay={(i % 3) * 0.08}
            className={cn("h-full", feature.span && "lg:col-span-2")}
          >
            <FeatureCard feature={feature} />
          </ScrollReveal>
        ))}
      </div>
    </section>
  );
}
