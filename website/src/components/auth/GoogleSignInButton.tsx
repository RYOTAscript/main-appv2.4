"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/**
 * "Continue with Google" — the app's only sign-in method. `callbackUrl`
 * preserves where the user was headed (e.g. checkout intent) after auth.
 */
export function GoogleSignInButton({
  callbackUrl = "/account",
  label = "Continue with Google",
  size = "lg",
  className,
}: {
  callbackUrl?: string;
  label?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [loading, setLoading] = useState(false);

  return (
    <Button
      variant="primary"
      size={size}
      className={cn("w-full", className)}
      disabled={loading}
      onClick={() => {
        setLoading(true);
        signIn("google", { callbackUrl });
      }}
    >
      {loading ? (
        <i className="fa-solid fa-circle-notch animate-spin text-sm" />
      ) : (
        <i className="fa-brands fa-google text-sm" />
      )}
      {loading ? "Redirecting…" : label}
    </Button>
  );
}
