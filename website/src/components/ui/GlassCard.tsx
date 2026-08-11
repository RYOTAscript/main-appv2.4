import { cn } from "@/lib/cn";

type GlassCardProps = {
  as?: keyof React.JSX.IntrinsicElements;
  glow?: boolean | "strong";
  hover?: boolean;
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>;

/**
 * The app's signature panel: rgba(8,8,8,.88) + blur(48px), hairline border,
 * very round corners, optional accent glow. `hover` adds the card's accent
 * border/shadow lift used throughout the app.
 */
export function GlassCard({
  as: Tag = "div",
  glow = true,
  hover = false,
  className,
  children,
  ...rest
}: GlassCardProps) {
  const Component = Tag as React.ElementType;
  return (
    <Component
      className={cn(
        "glass rounded-3xl border border-white/10",
        glow === "strong" ? "glow-strong" : glow ? "glow" : "",
        hover &&
          "transition-[border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1 hover:border-accent/20 hover:shadow-[0_0_30px_rgba(var(--accent),0.08)]",
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
}
