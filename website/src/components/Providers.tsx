"use client";

import { SessionProvider } from "next-auth/react";
import { AccentProvider } from "@/components/AccentProvider";

/** Client-side context providers shared across the app. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <AccentProvider>{children}</AccentProvider>
    </SessionProvider>
  );
}
