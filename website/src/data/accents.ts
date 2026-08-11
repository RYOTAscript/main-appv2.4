/**
 * Accent themes — mirrors the app's "Accent theme" swatches. Each accent is a
 * bare "R, G, B" string (for rgba(var(--accent), …)) plus its solid hex.
 * Default is white, so the site looks identical to the app until a theme is
 * picked. Changing the accent re-tints every glow surface site-wide.
 */
export type Accent = {
  id: string;
  label: string;
  rgb: string; // "R, G, B"
  solid: string; // "#rrggbb"
};

export const ACCENTS: Accent[] = [
  { id: "white", label: "White", rgb: "255, 255, 255", solid: "#ffffff" },
  { id: "cyan", label: "Cyan", rgb: "34, 211, 238", solid: "#22d3ee" },
  { id: "violet", label: "Violet", rgb: "167, 139, 250", solid: "#a78bfa" },
  { id: "pink", label: "Pink", rgb: "244, 114, 182", solid: "#f472b6" },
  { id: "green", label: "Green", rgb: "29, 185, 84", solid: "#1db954" },
];

export const DEFAULT_ACCENT_ID = "white";
export const ACCENT_STORAGE_KEY = "main-web-accent";
