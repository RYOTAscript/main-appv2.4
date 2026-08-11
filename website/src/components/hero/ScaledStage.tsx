"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// SSR-safe layout effect.
const useIso = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Renders a fixed-size stage (the 920×640 app window) and scales it down to fit
 * the available width, keeping it pixel-faithful instead of reflowing. Never
 * scales above 1, reserves the scaled height so the page flows, and horizontally
 * centers the (visually) scaled window within the container.
 */
export function ScaledStage({
  baseWidth,
  baseHeight,
  children,
  className,
}: {
  baseWidth: number;
  baseHeight: number;
  children: React.ReactNode;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState(0);

  useIso(() => {
    const el = wrapRef.current;
    if (!el) return;

    const measure = () => {
      const w = el.clientWidth;
      const s = Math.min(1, w / baseWidth);
      setScale(s);
      // Center the visually-scaled window (transform-origin is top-left).
      setOffset(Math.max(0, (w - baseWidth * s) / 2));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [baseWidth]);

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{ height: baseHeight * scale }}
    >
      <div
        style={{
          width: baseWidth,
          height: baseHeight,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          marginLeft: offset,
        }}
      >
        {children}
      </div>
    </div>
  );
}
