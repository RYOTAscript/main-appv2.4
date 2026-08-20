"use client";

import { useEffect, useState } from "react";

type OS = "windows" | "mac";

function detectOS(): OS {
  if (typeof navigator === "undefined") return "windows";
  const ua = (navigator.userAgent || "").toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();
  // iPadOS reports as "MacIntel" too, but that's fine — a Mac build is the right
  // suggestion for anything Apple-desktop-shaped; phones aren't a target anyway.
  if (ua.includes("mac") || platform.includes("mac")) return "mac";
  return "windows";
}

const PRIMARY_BTN =
  "inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-7 py-3.5 text-base font-medium text-black transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:bg-neutral-200 active:scale-[0.98]";

/**
 * OS-aware download buttons. Renders the visitor's platform as the primary
 * button and offers the other OS as a secondary link. Defaults to Windows for
 * SSR / first paint (the app's original platform), then refines to the real OS
 * after hydration. If only one URL is configured, only that button shows.
 */
export function DownloadButtons({ winUrl, macUrl }: { winUrl?: string; macUrl?: string }) {
  const [os, setOs] = useState<OS>("windows");
  useEffect(() => setOs(detectOS()), []);

  const hasWin = !!winUrl && winUrl !== "#";
  const hasMac = !!macUrl && macUrl !== "#";

  // Prefer the detected OS, but never show a button we have no URL for.
  const showMacPrimary = os === "mac" && hasMac;

  const primary = showMacPrimary
    ? { url: macUrl!, label: "Download for macOS", sub: "Apple Silicon & Intel · macOS 11+", icon: "fa-brands fa-apple" }
    : hasWin
      ? { url: winUrl!, label: "Download for Windows", sub: "Windows 10 / 11 · 64-bit", icon: "fa-solid fa-download" }
      : hasMac
        ? { url: macUrl!, label: "Download for macOS", sub: "Apple Silicon & Intel · macOS 11+", icon: "fa-brands fa-apple" }
        : null;

  // The alternate-OS link (only when both builds exist).
  const other =
    hasWin && hasMac
      ? showMacPrimary
        ? { url: winUrl!, label: "Windows", icon: "fa-brands fa-windows" }
        : { url: macUrl!, label: "macOS", icon: "fa-brands fa-apple" }
      : null;

  if (!primary) {
    return (
      <p className="text-sm text-neutral-400">
        No download is configured yet — please check back shortly.
      </p>
    );
  }

  return (
    <div>
      <a href={primary.url} className={PRIMARY_BTN}>
        <i className={`${primary.icon} text-sm`} />
        {primary.label}
      </a>
      <p className="mt-2 text-center font-mono text-[11px] tracking-wide text-neutral-500">
        {primary.sub}
      </p>
      {other && (
        <p className="mt-3 text-center text-xs text-neutral-500">
          or{" "}
          <a
            href={other.url}
            className="inline-flex items-center gap-1.5 text-neutral-300 underline decoration-white/20 underline-offset-2 transition-colors hover:text-white"
          >
            <i className={`${other.icon} text-[11px]`} />
            download for {other.label}
          </a>
        </p>
      )}
    </div>
  );
}
