"use client";

import { useEffect, useState } from "react";

/** Mono clock echoing the app header. 12-hour with AM/PM. */
export function LiveClock({ className }: { className?: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Render nothing until mounted to avoid hydration mismatch.
  if (!now) {
    return <span className={className} aria-hidden="true" />;
  }

  const h = now.getHours();
  const m = now.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = m.toString().padStart(2, "0");

  return (
    <span className={className} suppressHydrationWarning>
      {h12}:{mm}
      <span className="ml-1 text-neutral-600">{ampm}</span>
    </span>
  );
}
