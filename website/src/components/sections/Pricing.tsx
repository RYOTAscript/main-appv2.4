import { auth } from "@/lib/auth";
import { getUserLicense } from "@/lib/license";
import { PRODUCT } from "@/lib/product";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { ScrollReveal } from "@/components/ScrollReveal";
import { Button } from "@/components/ui/Button";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";
import { PayPalCheckout } from "@/components/account/PayPalCheckout";
import { LicenseKeyPill } from "@/components/account/LicenseKeyPill";

const INCLUDED = [
  "Every core feature — Spotify, lyrics, performance, FPS optimizer & more",
  "The full Widget Library — 27 mini widgets on Windows, 24 on macOS",
  "Free updates for the entire v4.x line",
  "Windows 10 & 11 · macOS 11+ · one license covers both",
  "Use it on up to 2 of your computers — free a slot any time",
  "Your unique license key + instant download",
];

export async function Pricing() {
  const session = await auth();
  const license = session?.user ? await getUserLicense(session.user.id) : null;
  const owned = Boolean(license?.active);

  return (
    <section
      id="pricing"
      className="relative mx-auto max-w-6xl px-6 pb-24 pt-12"
    >
      <ScrollReveal className="mb-12 text-center">
        <SectionLabel className="mb-4">Pricing</SectionLabel>
        <h2 className="display-type mx-auto max-w-2xl text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
          One price. Everything. Forever.
        </h2>
      </ScrollReveal>

      <ScrollReveal variant="pop" className="mx-auto max-w-md">
        <div className="glass glow-strong rounded-3xl border border-white/10 p-8">
          {/* Price */}
          <div className="flex items-end justify-center gap-2">
            <span className="display-type text-6xl font-bold tracking-tight text-white">
              {PRODUCT.priceDisplay}
            </span>
            <span className="mb-2 font-mono text-xs text-neutral-500">USD</span>
          </div>
          <p className="mt-2 text-center font-mono text-xs tracking-wide text-neutral-500">
            one-time · lifetime license
          </p>

          {/* Included */}
          <ul className="mt-8 space-y-3">
            {INCLUDED.map((item) => (
              <li key={item} className="flex items-start gap-3 text-sm text-neutral-300">
                <i className="fa-solid fa-check mt-0.5 text-[11px] text-accent-solid" />
                <span className="leading-relaxed">{item}</span>
              </li>
            ))}
          </ul>

          {/* CTA — depends on auth + purchase state */}
          <div className="mt-8">
            {owned && license ? (
              <div className="space-y-4">
                <div className="flex items-center justify-center gap-2 rounded-xl border border-green-500/30 bg-green-500/10 py-2 text-sm text-green-400">
                  <i className="fa-solid fa-circle-check text-xs" />
                  You own main
                </div>
                <LicenseKeyPill licenseKey={license.key} />
                <Button href="/download" variant="primary" size="lg" className="w-full">
                  <i className="fa-solid fa-download text-sm" />
                  Download for Windows
                </Button>
              </div>
            ) : session?.user ? (
              <PayPalCheckout />
            ) : (
              <GoogleSignInButton
                label="Continue with Google to buy"
                callbackUrl="/account"
              />
            )}
          </div>

          <p className="mt-5 text-center text-[11px] leading-relaxed text-neutral-500">
            <i className="fa-solid fa-lock mr-1 text-[10px]" />
            Secure checkout by PayPal. Instant license &amp; download.
          </p>
        </div>
      </ScrollReveal>
    </section>
  );
}
