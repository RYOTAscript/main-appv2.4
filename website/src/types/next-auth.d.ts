import type { DefaultSession } from "next-auth";

// Add the user id (from the adapter) to the session type.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      /** True when this account is on the ADMIN_EMAILS allowlist. */
      isAdmin?: boolean;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
  }
}
