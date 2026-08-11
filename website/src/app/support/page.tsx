import type { Metadata } from "next";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { ScrollReveal } from "@/components/ScrollReveal";
import { Button } from "@/components/ui/Button";

export const metadata: Metadata = {
  title: "Support · main",
};

const HELP = [
  {
    icon: "fa-download",
    title: "Install & setup",
    body: "Buy, sign in, and get your key + installer. Installing takes under a minute.",
    href: "/#pricing",
    cta: "Get main",
  },
  {
    icon: "fa-key",
    title: "License & billing",
    body: "Your key lives on your account and is tied to your Google sign-in — grab it any time.",
    href: "/account",
    cta: "Open account",
  },
  {
    icon: "fa-bug",
    title: "Something broke",
    body: "Hit a bug or a widget acting up? Send us the details and we'll get on it.",
    href: "mailto:support@main.app?subject=main%20bug%20report",
    cta: "Report a bug",
  },
];

const FAQ = [
  {
    q: "How do I get my license key?",
    a: "The moment your PayPal payment goes through, a unique key (MAIN-XXXX-XXXX-XXXX-XXXX) is provisioned to your account. You'll see it on your Account page and on the Download page instantly — no waiting on an email.",
  },
  {
    q: "I lost my key or got a new PC.",
    a: "No problem — your license is tied to your Google account, not a device. Just sign in and your key is right there on the Account and Download pages. Reinstall main on the new PC and you're set.",
  },
  {
    q: "Do you offer refunds?",
    a: "main is a digital product delivered instantly, so sales are generally final — but if it doesn't work for you and we can't fix it, email us within 14 days of purchase and we'll refund you. See the Terms for details.",
  },
  {
    q: "Which Windows versions are supported?",
    a: "Windows 10 and 11, 64-bit. main runs as a lightweight always-on overlay from your system tray.",
  },
  {
    q: "Will main get me banned from games?",
    a: "main automates your own Windows (media keys, overlays, macros, virtual controller input). Most of it is harmless, but some anti-cheat systems dislike overlays or virtual input — use those specific features at your own discretion.",
  },
  {
    q: "How do I connect Spotify?",
    a: "Create a free app at developer.spotify.com, paste its Client ID into main's Settings → Spotify, and add the redirect URI shown there. Then hit Connect — it uses secure PKCE OAuth, so your password never touches main.",
  },
];

export default function SupportPage() {
  return (
    <section className="relative mx-auto max-w-4xl px-6 pb-24 pt-32">
      <ScrollReveal className="mb-12 text-center">
        <SectionLabel className="mb-4">Support</SectionLabel>
        <h1 className="display-type mx-auto max-w-2xl text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
          Need a hand?
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-balance text-neutral-400">
          Answers to the common questions, and a direct line to us when you need
          it.
        </p>
      </ScrollReveal>

      {/* Help cards */}
      <div className="mb-14 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {HELP.map((card, i) => (
          <ScrollReveal key={card.title} delay={i * 0.08} className="h-full">
            <div className="group glass flex h-full flex-col rounded-3xl border border-white/10 p-6 glow transition-[border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1 hover:border-accent/20 hover:shadow-[0_0_30px_rgba(var(--accent),0.08)]">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-lg text-neutral-200 transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:scale-[1.12] group-hover:border-accent/40 group-hover:text-white">
                <i className={`fa-solid ${card.icon}`} />
              </div>
              <h3 className="text-base font-semibold tracking-tight text-white">
                {card.title}
              </h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-neutral-400">
                {card.body}
              </p>
              <a
                href={card.href}
                className="mt-4 inline-flex items-center gap-1.5 text-sm text-neutral-300 transition-colors hover:text-white"
              >
                {card.cta}
                <i className="fa-solid fa-arrow-right text-[10px]" />
              </a>
            </div>
          </ScrollReveal>
        ))}
      </div>

      {/* FAQ */}
      <ScrollReveal className="mb-6">
        <SectionLabel className="mb-4">Frequently asked</SectionLabel>
      </ScrollReveal>
      <div className="space-y-3">
        {FAQ.map((item, i) => (
          <ScrollReveal key={item.q} delay={Math.min(i * 0.05, 0.25)}>
            <details className="group glass overflow-hidden rounded-2xl border border-white/10 glow">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 text-sm font-medium text-white marker:content-none">
                {item.q}
                <i className="fa-solid fa-chevron-down text-xs text-neutral-500 transition-transform duration-200 group-open:rotate-180" />
              </summary>
              <div className="px-6 pb-5 text-sm leading-relaxed text-neutral-400">
                {item.a}
              </div>
            </details>
          </ScrollReveal>
        ))}
      </div>

      {/* Contact */}
      <ScrollReveal className="mt-14">
        <div className="glass glow-strong flex flex-col items-center gap-5 rounded-3xl border border-white/10 p-8 text-center sm:flex-row sm:justify-between sm:text-left">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-white">
              Still stuck? Email us.
            </h2>
            <p className="mt-1 text-sm text-neutral-400">
              We usually reply within a day. Include your account email and what
              you were doing when it happened.
            </p>
          </div>
          <Button
            href="mailto:support@main.app?subject=main%20support"
            variant="primary"
            size="lg"
            className="flex-shrink-0"
          >
            <i className="fa-solid fa-envelope text-sm" />
            support@main.app
          </Button>
        </div>
      </ScrollReveal>
    </section>
  );
}
