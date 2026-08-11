import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserLicense } from "@/lib/license";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { Button } from "@/components/ui/Button";
import { AccentPicker } from "@/components/AccentPicker";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { LicenseKeyPill } from "@/components/account/LicenseKeyPill";
import { PayPalCheckout } from "@/components/account/PayPalCheckout";

export const metadata: Metadata = {
  title: "Account · main",
};

export const dynamic = "force-dynamic";

function initials(name?: string | null, email?: string | null) {
  const base = name || email || "?";
  return base.trim().charAt(0).toUpperCase();
}

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/account");

  const user = session.user;
  const license = await getUserLicense(user.id);
  const active = Boolean(license?.active);

  return (
    <section className="relative mx-auto max-w-3xl px-6 pb-24 pt-32">
      <div className="glass glow-strong overflow-hidden rounded-3xl border border-white/10">
        {/* Sticky header (echoes the app's Settings modal) */}
        <div className="flex items-center justify-between border-b border-white/10 px-8 py-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">
              Account
            </h1>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="live-dot" />
              <p className="text-xs text-neutral-500">Signed in with Google</p>
            </div>
          </div>
          <SignOutButton />
        </div>

        <div className="space-y-10 px-8 py-8">
          {/* Profile */}
          <div className="flex items-center gap-4">
            {user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.image}
                alt=""
                className="h-16 w-16 rounded-2xl border border-white/10 object-cover"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-2xl font-semibold text-white">
                {initials(user.name, user.email)}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold text-white">
                {user.name || "main user"}
              </p>
              <p className="truncate text-sm text-neutral-400">{user.email}</p>
            </div>
          </div>

          {/* License */}
          <div>
            <SectionLabel className="mb-4">License</SectionLabel>
            {active && license ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <div className="mb-4 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-green-500/30 bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-400">
                    <i className="fa-solid fa-circle-check text-[10px]" />
                    Active
                  </span>
                  <span className="font-mono text-xs text-neutral-500">
                    since{" "}
                    {new Date(license.issuedAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
                <p className="mb-2 text-xs text-neutral-500">Your license key</p>
                <LicenseKeyPill licenseKey={license.key} />
                <div className="mt-5">
                  <Button href="/download" variant="secondary" size="md">
                    <i className="fa-solid fa-download text-xs" />
                    Download for Windows
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <div className="mb-4 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-medium text-neutral-300">
                    <i className="fa-regular fa-circle text-[10px]" />
                    Not purchased
                  </span>
                </div>
                <p className="mb-4 max-w-md text-sm text-neutral-400">
                  Buy a lifetime license to unlock the Windows download and get
                  your unique key. One-time $5 — no subscription.
                </p>
                <div className="max-w-xs">
                  <PayPalCheckout />
                </div>
              </div>
            )}
          </div>

          {/* Accent theme */}
          <div>
            <SectionLabel className="mb-4">Accent theme</SectionLabel>
            <p className="mb-3 max-w-md text-sm text-neutral-400">
              Re-tints the whole site — the glow, bars, toggles and links — just
              like the app&apos;s accent picker.
            </p>
            <AccentPicker />
          </div>
        </div>
      </div>
    </section>
  );
}
