import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { ScrollReveal } from "@/components/ScrollReveal";
import { ScaledStage } from "@/components/hero/ScaledStage";
import { AppWindowMock } from "@/components/hero/AppWindowMock";
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
            lyrics, live performance, one-click FPS tweaks, quick launch, and 19
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

        {/* App-window mock — the centerpiece */}
        <ScrollReveal delay={0.2} className="mt-16 w-full">
          {/* max-md:overflow-x-clip: the mock is laid out at a fixed 920px and
              only visually shrunk via transform:scale, and the spotlight bleeds
              past the edges — both overflow a phone viewport and let momentum
              scroll drag sideways. Clip that horizontal overflow on mobile
              (clip, not hidden, so it adds no scroll container); desktop keeps
              the full ambient glow. */}
          <div className="relative w-full max-md:overflow-x-clip">
            {/* Spotlight + floor glow behind the window */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-x-10 -top-10 bottom-0 -z-10"
            >
              <div className="absolute left-1/2 top-0 h-[60%] w-[80%] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(var(--accent),0.10),transparent_70%)] blur-2xl" />
              <div className="absolute bottom-4 left-1/2 h-24 w-[70%] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(var(--accent),0.12),transparent_70%)] blur-2xl" />
            </div>
            <div className="hero-float mx-auto w-full max-w-[960px]">
              <ScaledStage baseWidth={920} baseHeight={640} className="w-full">
                <AppWindowMock />
              </ScaledStage>
            </div>
          </div>
        </ScrollReveal>
      </section>

      <Features />

      <WidgetLibrary />

      <Pricing />
    </>
  );
}
