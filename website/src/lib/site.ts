/**
 * Site-wide constants (URL, brand, current app version) — the single source of
 * truth for things that were previously hardcoded in a dozen places. Bumping
 * the app version or moving domains happens here, once.
 */

// The canonical, deployed origin. Metadata (OG/canonical/sitemap) resolve
// against this, so it must be the real public URL — not a placeholder domain.
// Overridable per-environment via NEXT_PUBLIC_SITE_URL (e.g. preview builds).
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
  "https://main-website-eosin-beta.vercel.app";

export const SITE = {
  name: "main",
  /** Current desktop-app version — kept in sync with main-app11 package.json. */
  version: "3.48.4",
  tagline: "your desktop, glassed.",
  author: "ryota",
  description:
    "An always-on glass-morphism Windows overlay for gaming and power users — Spotify with synced lyrics, live performance, one-click FPS tweaks, quick launch, and 22 mini widgets. One-time $5 lifetime license.",
} as const;

/** Prefixed "v" label, e.g. "v3.48.4". */
export const VERSION_LABEL = `v${SITE.version}`;
