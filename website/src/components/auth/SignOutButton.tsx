"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/Button";

export function SignOutButton() {
  return (
    <Button variant="ghost" size="md" onClick={() => signOut({ callbackUrl: "/" })}>
      <i className="fa-solid fa-arrow-right-from-bracket text-xs" />
      Sign out
    </Button>
  );
}
