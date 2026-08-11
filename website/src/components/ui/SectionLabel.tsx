import { cn } from "@/lib/cn";

/** The app's small-caps section label ("FEATURES", "PRICING", …). */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <p className={cn("section-label", className)}>{children}</p>;
}
