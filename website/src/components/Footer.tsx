import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { AccentPicker } from "@/components/AccentPicker";
import { VERSION_LABEL } from "@/lib/site";

const FOOTER_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#widgets", label: "Widgets" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/legal", label: "Legal" },
  { href: "/support", label: "Support" },
];

export function Footer() {
  return (
    <footer className="relative z-10 mt-24 border-t border-white/10">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Logo size={36} />
          <div className="leading-tight">
            <span className="block text-lg font-semibold tracking-tight text-white">
              main
            </span>
            <span className="block font-mono text-[10px] tracking-widest text-neutral-600">
              <span className="text-neutral-700">made by ryota</span> · {VERSION_LABEL}
            </span>
          </div>
        </div>

        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {FOOTER_LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="text-xs text-neutral-500 transition-colors hover:text-neutral-200"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex flex-col gap-2">
          <span className="section-label">Accent</span>
          <AccentPicker />
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-6 pb-10">
        <p className="font-mono text-[10px] leading-relaxed tracking-wide text-neutral-700">
          main is a Windows 10/11 desktop overlay. It is an independent product
          and is not affiliated with, endorsed by, or sponsored by Microsoft,
          Spotify, Discord, Riot Games (Valorant), TikTok / ByteDance, Valve
          (Steam), or Epic Games. All product names, logos and trademarks are the
          property of their respective owners and are used for identification
          only. © {new Date().getFullYear()} ryota.
        </p>
      </div>
    </footer>
  );
}
