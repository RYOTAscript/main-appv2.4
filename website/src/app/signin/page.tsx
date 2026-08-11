import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Logo } from "@/components/ui/Logo";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

export const metadata: Metadata = {
  title: "Sign in · main",
};

export const dynamic = "force-dynamic";

/**
 * Glass sign-in dialog (modalPop). Google only — no email/password. Preserves
 * a `callbackUrl` so checkout/return intent survives the round-trip.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: { callbackUrl?: string };
}) {
  const session = await auth();
  const callbackUrl = searchParams.callbackUrl || "/account";

  // Already signed in — skip the dialog.
  if (session?.user) redirect(callbackUrl);

  return (
    <section className="relative mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-32">
      <div className="glass glow-strong w-full animate-modal-pop rounded-3xl border border-white/10 p-8 text-center">
        <Logo size={56} className="mx-auto mb-6" />

        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Welcome to main
        </h1>
        <p className="mx-auto mt-2 max-w-xs text-sm text-neutral-400">
          Sign in to buy your lifetime license, get your key, and download for
          Windows.
        </p>

        <div className="mt-7">
          <GoogleSignInButton callbackUrl={callbackUrl} />
        </div>

        <p className="mt-6 text-[11px] leading-relaxed text-neutral-600">
          By continuing you agree to our{" "}
          <Link href="/terms" className="text-neutral-400 underline hover:text-white">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="text-neutral-400 underline hover:text-white">
            Privacy Policy
          </Link>
          . We only use Google to sign you in.
        </p>
      </div>

      <Link
        href="/"
        className="mt-6 text-xs text-neutral-500 transition-colors hover:text-neutral-300"
      >
        <i className="fa-solid fa-arrow-left mr-1.5 text-[10px]" />
        Back to site
      </Link>
    </section>
  );
}
