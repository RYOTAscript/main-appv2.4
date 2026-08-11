"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

/** Mono license-key pill with a copy button + confirmation pop. */
export function LicenseKeyPill({ licenseKey }: { licenseKey: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(licenseKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate rounded-xl border border-white/10 bg-neutral-950/80 px-4 py-2.5 font-mono text-sm tracking-wide text-white">
        {licenseKey}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy license key"
        className={cn(
          "window-btn h-10 w-10 flex-shrink-0 transition-transform",
          copied && "scale-110 border-accent/50 text-white",
        )}
        title={copied ? "Copied!" : "Copy"}
      >
        <i className={cn("fa-solid text-xs", copied ? "fa-check" : "fa-copy")} />
      </button>
    </div>
  );
}
