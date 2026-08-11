"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/** Nav auth control — account avatar when signed in, Google sign-in otherwise. */
export function NavAuth({ className }: { className?: string }) {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div
        className={cn(
          "h-8 w-20 animate-pulse rounded-2xl bg-white/5",
          className,
        )}
      />
    );
  }

  if (session?.user) {
    const user = session.user;
    return (
      <Link
        href="/account"
        className={cn(
          "inline-flex items-center gap-2 rounded-2xl border border-white/12 bg-white/[0.06] py-1 pl-1 pr-3 text-sm text-neutral-200 transition-colors hover:border-white/25 hover:text-white",
          className,
        )}
        title="Your account"
      >
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.image}
            alt=""
            className="h-7 w-7 rounded-xl object-cover"
          />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-white/10 text-xs font-semibold">
            {(user.name || user.email || "?").charAt(0).toUpperCase()}
          </span>
        )}
        <span className="hidden max-w-[8rem] truncate sm:inline">
          {user.name?.split(" ")[0] || "Account"}
        </span>
      </Link>
    );
  }

  return (
    <Button
      href="/signin"
      variant="primary"
      size="sm"
      className={cn("hidden sm:inline-flex", className)}
    >
      <i className="fa-brands fa-google text-xs" />
      Sign in
    </Button>
  );
}
