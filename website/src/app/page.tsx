import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { ScrollReveal } from "@/components/ScrollReveal";
import { HeroApp } from "@/components/hero/HeroApp";
import { Features } from "@/components/sections/Features";
import { WidgetLibrary } from "@/components/sections/WidgetLibrary";
import { Pricing } from "@/components/sections/Pricing";
import { VERSION_LABEL } from "@/lib/site";

export default function HomePage() {
  return (
    <>
      {/* ═══════════════ Hero ═══════════════ */}
      <section className="relative mx-auto flex min-h-screen max-w-6xl flex-col items-center px-6 pb-24 pt-32 text-center sm:pt-36">
        <ScrollReveal delay={0}>
          <Link
            href="/#pricing"
            className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5 text-xs text-neutral-300 transition-colors hover:border-accent/30 hover:text-white"
          >
            <span className="live-dot" />
            <span className="font-mono">{VERSION_LABEL}</span>
            <span className="text-neutral-600">·</span>
            <span>one-time $5 · lifetime</span>
            <i className="fas fa-arrow-right text-[10px] text-neutral-500" />
          </Link>
        </ScrollReveal>

        <ScrollReveal delay={0.08}>
          <h1 className="display-type max-w-3xl text-balance text-5xl font-bold leading-[1.05] tracking-tight text-white sm:text-6xl md:text-7xl">
            Your desktop, glassed.
          </h1>
        </ScrollReveal>

        <ScrollReveal delay={0.16}>
          <p className="mt-6 max-w-xl text-balance text-lg text-neutral-400">
            An always-on glass-morphism overlay for Windows — Spotify with synced
            lyrics, live performance, one-click FPS tweaks, quick launch, and 22
            mini widgets. Built for gaming and power users.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={0.24}>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button href="/#pricing" variant="primary" size="lg">
              Get main — $5
            </Button>
            <Button href="/#features" variant="secondary" size="lg">
              See features
              <i className="fas fa-arrow-down text-xs" />
            </Button>
          </div>
        </ScrollReveal>

        <ScrollReveal delay={0.32}>
          <p className="mt-6 font-mono text-xs tracking-wide text-neutral-600">
            One-time payment · Lifetime license · Windows 10/11
          </p>
        </ScrollReveal>

        {/* App-window mock — the centerpiece (interactive: customizable widgets
            + synced-lyrics demo, all in <HeroApp>). */}
        <ScrollReveal delay={0.2} className="mt-16 w-full">
          <HeroApp />
        </ScrollReveal>
      </section>

      <Features />

      <WidgetLibrary />

      <Pricing />
    </>
  );
}
