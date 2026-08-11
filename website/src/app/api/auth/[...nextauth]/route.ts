import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

// The NextAuth route handler for the App Router.
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
