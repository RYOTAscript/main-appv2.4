import Link from "next/link";
import { forwardRef } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 font-medium select-none " +
  "transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] " +
  "hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.97] " +
  "disabled:opacity-50 disabled:pointer-events-none disabled:hover:translate-y-0 " +
  "focus-visible:outline-none";

const variants: Record<Variant, string> = {
  // Primary CTA — solid white bg, black text (the app's "Done" button).
  primary:
    "bg-white text-black rounded-2xl hover:bg-neutral-200 shadow-[0_2px_20px_rgba(var(--accent),0.10)] hover:shadow-[0_4px_28px_rgba(var(--accent),0.18)]",
  // Secondary — transparent, hairline border.
  secondary:
    "bg-white/[0.08] text-white border border-white/12 rounded-2xl hover:bg-white/15 hover:border-white/25",
  // Ghost — 32px-ish square window button feel, muted.
  ghost:
    "bg-white/[0.04] text-neutral-300 border border-white/12 rounded-xl hover:bg-white/10 hover:text-white hover:border-white/25",
};

const sizes: Record<Size, string> = {
  sm: "text-xs px-3.5 py-2",
  md: "text-sm px-5 py-2.5",
  lg: "text-base px-7 py-3.5",
};

type CommonProps = {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: React.ReactNode;
};

type ButtonAsButton = CommonProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & {
    href?: undefined;
  };

type ButtonAsLink = CommonProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> & {
    href: string;
  };

export type ButtonProps = ButtonAsButton | ButtonAsLink;

export const Button = forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ButtonProps
>(function Button(
  { variant = "primary", size = "md", className, children, ...props },
  ref,
) {
  const classes = cn(base, variants[variant], sizes[size], className);

  if ("href" in props && props.href !== undefined) {
    const { href, ...rest } = props as ButtonAsLink;
    const isInternal = href.startsWith("/") || href.startsWith("#");
    if (isInternal) {
      return (
        <Link
          href={href}
          ref={ref as React.Ref<HTMLAnchorElement>}
          className={classes}
          {...rest}
        >
          {children}
        </Link>
      );
    }
    return (
      <a
        href={href}
        ref={ref as React.Ref<HTMLAnchorElement>}
        className={classes}
        {...rest}
      >
        {children}
      </a>
    );
  }

  const { type = "button", ...rest } = props as ButtonAsButton;
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type={type}
      className={classes}
      {...rest}
    >
      {children}
    </button>
  );
});
