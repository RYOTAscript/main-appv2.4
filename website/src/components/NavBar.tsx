"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";
import { LiveClock } from "@/components/LiveClock";
import { NavAuth } from "@/components/NavAuth";
import { VERSION_LABEL } from "@/lib/site";
import { cn } from "@/lib/cn";

const NAV_LINKS = [
  { href: "/#features", id: "features", label: "Features" },
  { href: "/#widgets", id: "widgets", label: "Widgets" },
  { href: "/#pricing", id: "pricing", label: "Pricing" },
];

export function NavBar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Scrollspy: highlight the nav link for whichever section owns the middle of
  // the viewport. Only the home page has these anchors; elsewhere nothing
  // matches and no link is marked active.
  useEffect(() => {
    const sections = NAV_LINKS.map((l) => document.getElementById(l.id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    if (sections.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: [0, 0.25, 0.5, 1] },
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);

  // Close the mobile menu on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Cold deep-links (someone opens /#pricing directly): the browser's initial
  // hash jump fires before fonts/the app-window mock finish laying out, so it
  // lands in the wrong place — and the target section's scroll-reveal children
  // are still faded out. After mount, reveal the target and re-scroll to it
  // once layout has settled.
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, "");
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    const settle = window.setTimeout(() => {
      el.querySelectorAll(".reveal, .reveal-pop").forEach((child) =>
        child.classList.add("is-visible"),
      );
      el.scrollIntoView({ behavior: "auto", block: "start" });
      setActive(id);
    }, 350);
    return () => window.clearTimeout(settle);
  }, []);

  // Scroll to a section ourselves rather than relying on Next's hash handling,
  // which doesn't reliably scroll for same-page `/#id` links. scrollIntoView
  // honours the CSS scroll-padding-top (the nav offset) and smooth behaviour, so
  // the heading lands cleanly just below the navbar. We also nudge the section's
  // scroll-reveal children to appear immediately so we never arrive on a section
  // whose content is still faded out.
  const handleNavClick = (
    e: React.MouseEvent<HTMLAnchorElement>,
    id: string,
  ) => {
    // Only intercept when the section exists on the current page (the home page).
    const el = document.getElementById(id);
    if (!el) return; // e.g. on /account — let the link navigate to "/#id".
    e.preventDefault();
    setOpen(false);
    setActive(id);
    el.querySelectorAll(".reveal, .reveal-pop").forEach((child) =>
      child.classList.add("is-visible"),
    );
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // Keep the URL in sync without a second scroll jump.
    history.replaceState(null, "", `#${id}`);
  };

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-4 pt-4">
      <nav
        className={cn(
          "mx-auto flex max-w-6xl items-center justify-between gap-4 rounded-2xl border border-white/10 px-4 py-2.5 sm:px-6",
          "glass transition-shadow duration-300",
          scrolled ? "glow" : "shadow-none",
        )}
      >
        {/* Wordmark */}
        <Link href="/" className="flex items-center gap-3 no-underline">
          <Logo size={36} />
          <div className="leading-none">
            <span className="block text-2xl font-semibold tracking-tight text-white">
              main
            </span>
            <span className="block font-mono text-[10px] tracking-widest text-neutral-500">
              {VERSION_LABEL}
            </span>
          </div>
        </Link>

        {/* Center links (desktop) */}
        <div className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => {
            const isActive = active === link.id;
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={(e) => handleNavClick(e, link.id)}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "nav-underline rounded-lg px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "nav-underline--active text-white"
                    : "text-neutral-400 hover:text-white",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </div>

        {/* Right flourish */}
        <div className="flex items-center gap-3">
          <LiveClock className="hidden font-mono text-sm tabular-nums text-neutral-400 sm:inline-flex" />
          <NavAuth />
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((v) => !v)}
            className="window-btn md:hidden"
          >
            <i className={cn("fas", open ? "fa-xmark" : "fa-bars", "text-xs")} />
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      <div
        id="mobile-menu"
        className={cn(
          "mx-auto max-w-6xl overflow-hidden md:hidden",
          "transition-[max-height,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          open
            ? "mt-2 max-h-96 translate-y-0 opacity-100"
            : "pointer-events-none max-h-0 -translate-y-2 opacity-0",
        )}
      >
        <div className="glass glow flex flex-col gap-1 rounded-2xl border border-white/10 p-3">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={(e) => handleNavClick(e, link.id)}
              aria-current={active === link.id ? "true" : undefined}
              className={cn(
                "rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-white/5 hover:text-white",
                active === link.id ? "text-white" : "text-neutral-300",
              )}
            >
              {link.label}
            </Link>
          ))}
          <Button
            href="/signin"
            variant="primary"
            size="sm"
            className="mt-1"
            onClick={() => setOpen(false)}
          >
            <i className="fa-brands fa-google text-xs" />
            Sign in
          </Button>
        </div>
      </div>
    </header>
  );
}
