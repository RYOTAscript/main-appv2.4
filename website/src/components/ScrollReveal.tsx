"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Wraps children in the app's `fadeIn` scroll-reveal (rise + slight scale),
 * fired once when it scrolls into view via IntersectionObserver. `delay`
 * staggers siblings exactly like the app's reveal-item delays (0.08s, 0.16s…).
 */
export function ScrollReveal({
  children,
  delay = 0,
  className,
  as: Tag = "div",
  once = true,
  variant = "fade",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: keyof React.JSX.IntrinsicElements;
  once?: boolean;
  variant?: "fade" | "pop";
}) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setVisible(true);
            if (once) io.unobserve(entry.target);
          } else if (!once) {
            setVisible(false);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [once]);

  const Component = Tag as React.ElementType;
  return (
    <Component
      ref={ref}
      className={cn(
        variant === "pop" ? "reveal-pop" : "reveal",
        visible && "is-visible",
        className,
      )}
      style={{ animationDelay: `${delay}s` }}
    >
      {children}
    </Component>
  );
}
