import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

/**
 * NextAuth config. Google is the only provider (no email/password). The Prisma
 * adapter persists User/Account so we can attach licenses per user; sessions
 * are JWT so pages/routes can read the session without a DB round-trip. The
 * user id is threaded into the token and session for downstream license
 * lookups.
 */
export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/signin",
  },
  callbacks: {
    async jwt({ token, user }) {
      // On sign-in, `user` is the adapter user — persist its id on the token.
      if (user) token.uid = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.uid as string) ?? (token.sub as string);
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

/** Server-side session helper. */
export function auth() {
  return getServerSession(authOptions);
}
