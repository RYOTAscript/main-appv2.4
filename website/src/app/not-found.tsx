import type { Metadata } from "next";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { VERSION_LABEL } from "@/lib/site";

export const metadata: Metadata = {
  title: "404 — lost in the glass · main",
};

/**
 * Custom glass 404. Renders inside the root layout, so it sits on the same
 * animated background with the nav + footer. Themed like a "missing widget"
 * from the library, complete with the app's spinning ring + live dot.
 */
export default function NotFound() {
  return (
    <section className="relative mx-auto flex min-h-[80vh] max-w-3xl flex-col items-center justify-center px-6 pt-32 text-center">
      {/* Glowing 404 badge with the app's spinning ring */}
      <div className="relative mb-10">
        <div className="spin-ring flex h-28 w-28 items-center justify-center rounded-full border border-white/10">
          <div className="glass flex h-24 w-24 items-center justify-center rounded-full border border-white/10 glow-strong">
            <Logo size={56} rounded="rounded-2xl" bordered={false} />
          </div>
        </div>
        {/* Floating "offline" dot */}
        <span className="live-dot absolute right-1 top-1" />
      </div>

      <SectionLabel className="mb-4">Error 404</SectionLabel>

      <h1
        className="display-type text-7xl font-bold tracking-tight text-white sm:text-8xl"
        style={{
          textShadow: "0 0 40px rgba(var(--accent), 0.25)",
        }}
      >
        404
      </h1>

      <p className="mt-5 max-w-md text-balance text-lg text-neutral-400">
        This widget isn&apos;t in the library. The page you were looking for
        drifted off the glass — or never existed.
      </p>

      <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
        <Button href="/" variant="primary" size="lg">
          <i className="fa-solid fa-house text-xs" />
          Back home
        </Button>
        <Button href="/#widgets" variant="secondary" size="lg">
          Browse widgets
          <i className="fa-solid fa-arrow-right text-xs" />
        </Button>
      </div>

      <p className="mt-10 font-mono text-xs tracking-wide text-neutral-600">
        <span className="text-neutral-700">main</span> · {VERSION_LABEL} · route not
        found
      </p>
    </section>
  );
}
