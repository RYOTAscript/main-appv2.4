import type { Config } from "tailwindcss";

/**
 * Design tokens are lifted verbatim from the desktop app's stylesheet
 * (main-app11/main-app/styles/main.css + backgrounds.css). The accent system
 * is intentionally driven by CSS variables (--accent as bare "R, G, B", plus
 * --accent-solid) so a single change re-tints the whole site, exactly like the
 * app's "Accent theme" feature. See globals.css for the variable definitions.
 */
const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/data/**/*.{ts,tsx}",
  ],
  darkMode: "class", // dark-only app — <html> is always .dark
  theme: {
    extend: {
      colors: {
        // Page background near-black, matching the app's #080808 canvas.
        ink: "#080808",
        // Accent references the runtime CSS variable so `bg-accent`, `text-accent`
        // etc. follow the picker. Alpha via the <alpha-value> placeholder.
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-solid": "var(--accent-solid)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "sans-serif"],
        mono: ["var(--font-jetbrains)", "JetBrains Mono", "monospace"],
        display: [
          "-apple-system",
          "SF Pro Display",
          "Segoe UI",
          "var(--font-inter)",
          "sans-serif",
        ],
      },
      borderRadius: {
        // The app's hero container is 32px; cards 24px (rounded-3xl is already 24).
        window: "32px",
      },
      letterSpacing: {
        label: "0.2em",
      },
      boxShadow: {
        glow:
          "0 0 var(--glow-spread) rgba(var(--accent), var(--glow-strength)), inset 0 1px 0 rgba(255,255,255,0.06)",
        "glow-strong":
          "0 0 calc(var(--glow-spread) * 1.5) rgba(var(--accent), calc(var(--glow-strength) * 1.8)), 0 0 80px rgba(var(--accent), calc(var(--glow-strength) * 0.5)), inset 0 1px 0 rgba(255,255,255,0.1)",
      },
      transitionTimingFunction: {
        // The app's two signature curves.
        ease: "cubic-bezier(0.22, 1, 0.36, 1)", // reveals / eases
        spring: "cubic-bezier(0.34, 1.56, 0.64, 1)", // springy pops / hovers
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0", transform: "translateY(24px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        modalPop: {
          from: { opacity: "0", transform: "scale(0.82)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        gridDrift: {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(48px)" },
        },
        pulseGlow: {
          "0%, 100%": { opacity: "0.5" },
          "50%": { opacity: "1" },
        },
        ringSpin: {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        livePulse: {
          "0%, 100%": { opacity: "0.35", transform: "scale(0.85)" },
          "50%": { opacity: "1", transform: "scale(1)" },
        },
        bgBlobA: {
          from: { transform: "translate(0, 0) scale(1)" },
          "50%": { transform: "translate(28%, 20%) scale(1.22)" },
          to: { transform: "translate(10%, 38%) scale(0.95)" },
        },
        bgBlobB: {
          from: { transform: "translate(0, 0) scale(1.1)" },
          "50%": { transform: "translate(-24%, -16%) scale(0.9)" },
          to: { transform: "translate(-8%, -34%) scale(1.18)" },
        },
        bgBlobC: {
          from: { transform: "translate(0, 0) scale(0.92)" },
          "50%": { transform: "translate(-20%, 14%) scale(1.15)" },
          to: { transform: "translate(16%, -18%) scale(1)" },
        },
        spin: {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
      },
      animation: {
        "fade-in": "fadeIn 1s cubic-bezier(0.22,1,0.36,1) forwards",
        "modal-pop": "modalPop 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards",
        "grid-drift": "gridDrift 24s linear infinite",
        "pulse-glow": "pulseGlow 3s ease-in-out infinite",
        "ring-spin": "ringSpin 8s linear infinite",
        "live-pulse": "livePulse 2.5s ease-in-out infinite",
        "blob-a": "bgBlobA 38s ease-in-out infinite alternate",
        "blob-b": "bgBlobB 47s ease-in-out infinite alternate",
        "blob-c": "bgBlobC 56s ease-in-out infinite alternate",
        "spin-slow": "spin 8s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
