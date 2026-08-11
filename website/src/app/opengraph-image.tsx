import { ImageResponse } from "next/og";
import { SITE, VERSION_LABEL } from "@/lib/site";

// Edge runtime: the Node build of @vercel/og fails to resolve its default font
// during `next build` on Windows ("Invalid URL"); the edge build bundles it.
export const runtime = "edge";

// Branded 1200×630 social card used for og:image AND twitter:image (Next reuses
// this file for both). Previously there was no share image at all — links
// pasted into Slack/Discord/X rendered as a bare grey box.
export const alt = `main — ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          // Satori (next/og) only supports simple gradient syntax — no
          // "<size> at <pos>" radials. A diagonal linear with accent-tinted
          // stops gives the same dark, subtly-coloured depth and renders
          // reliably.
          backgroundColor: "#080808",
          backgroundImage:
            "linear-gradient(135deg, rgba(129,140,248,0.20) 0%, rgba(8,8,8,0) 38%), linear-gradient(315deg, rgba(34,211,238,0.16) 0%, rgba(8,8,8,0) 42%)",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <svg width="72" height="72" viewBox="0 0 100 100" fill="none">
            <path
              d="M50 4 C54 32, 68 46, 96 50 C68 54, 54 68, 50 96 C46 68, 32 54, 4 50 C32 46, 46 32, 50 4 Z"
              fill="#ffffff"
            />
          </svg>
          <span style={{ fontSize: 30, letterSpacing: 8, color: "#9ca3af" }}>
            {VERSION_LABEL.toUpperCase()}
          </span>
        </div>

        <div
          style={{
            display: "flex",
            fontSize: 128,
            fontWeight: 800,
            letterSpacing: -4,
            marginTop: 40,
          }}
        >
          main
        </div>

        <div
          style={{
            display: "flex",
            fontSize: 44,
            color: "#a3a3a3",
            marginTop: 8,
          }}
        >
          your desktop, glassed.
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            marginTop: 56,
            fontSize: 28,
            color: "#d4d4d4",
          }}
        >
          <span
            style={{
              display: "flex",
              padding: "10px 22px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.05)",
            }}
          >
            Windows 10 / 11
          </span>
          <span
            style={{
              display: "flex",
              padding: "10px 22px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.05)",
            }}
          >
            $5 · lifetime
          </span>
          <span
            style={{
              display: "flex",
              padding: "10px 22px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.05)",
            }}
          >
            19 mini widgets
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
