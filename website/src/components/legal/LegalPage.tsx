import { SectionLabel } from "@/components/ui/SectionLabel";

/** Shared shell for Terms / Privacy — glass, readable, same type system. */
export function LegalPage({
  label,
  title,
  updated,
  children,
}: {
  label: string;
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <section className="relative mx-auto max-w-3xl px-6 pb-24 pt-32">
      <div className="mb-8">
        <SectionLabel className="mb-3">{label}</SectionLabel>
        <h1 className="display-type text-4xl font-bold tracking-tight text-white sm:text-5xl">
          {title}
        </h1>
        <p className="mt-3 font-mono text-xs text-neutral-500">
          Last updated {updated}
        </p>
      </div>

      <div className="glass glow rounded-3xl border border-white/10 p-8 legal-prose">
        {children}
      </div>
    </section>
  );
}
