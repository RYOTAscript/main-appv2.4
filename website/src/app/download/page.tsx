import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserLicense } from "@/lib/license";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { Logo } from "@/components/ui/Logo";
import { LicenseKeyPill } from "@/components/account/LicenseKeyPill";
import { DownloadButtons } from "@/components/download/DownloadButtons";
import { VERSION_LABEL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Download · main",
};

export const dynamic = "force-dynamic";

const STEPS = [
  "Open the download — on Windows run the installer (at the SmartScreen prompt choose “More info → Run anyway”); on macOS open the .dmg and drag main to Applications.",
  "main launches into your menu bar / system tray and opens the glass window.",
  "Open Settings → paste your license key if prompted, then make it yours: pick an accent, a background, and your widgets.",
];

export default async function DownloadPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/download");

  const license = await getUserLicense(session.user.id);
  // Purchase-gated: no active license → send them to buy.
  if (!license?.active) redirect("/#pricing");

  // One license unlocks both builds. DOWNLOAD_URL = Windows (kept for back-compat);
  // DOWNLOAD_URL_MAC = the macOS .dmg (optional — Mac button hidden when unset).
  const winUrl = process.env.DOWNLOAD_URL || "";
  const macUrl = process.env.DOWNLOAD_URL_MAC || "";

  return (
    <section className="relative mx-auto max-w-2xl px-6 pb-24 pt-32">
      <div className="glass glow-strong rounded-3xl border border-white/10 p-8">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={48} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">
              Download main
            </h1>
            <p className="font-mono text-[11px] tracking-widest text-neutral-500">
              {VERSION_LABEL} · Windows 10/11 · macOS 11+ · 64-bit
            </p>
          </div>
        </div>

        <DownloadButtons winUrl={winUrl} macUrl={macUrl} />

        <div className="mt-8">
          <SectionLabel className="mb-3">Your license key</SectionLabel>
          <LicenseKeyPill licenseKey={license.key} />
          <p className="mt-2 text-xs text-neutral-500">
            Keep this safe — it&apos;s tied to your account and unlocks main on
            your Mac or PC.
          </p>
        </div>

        <div className="mt-8">
          <SectionLabel className="mb-3">Install</SectionLabel>
          <ol className="space-y-3">
            {STEPS.map((step, i) => (
              <li key={i} className="flex gap-3 text-sm text-neutral-300">
                <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 font-mono text-[11px] text-neutral-400">
                  {i + 1}
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
