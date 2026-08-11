import { ImageResponse } from "next/og";

// Edge runtime: the Node build of @vercel/og fails to resolve its default font
// during `next build` on Windows ("Invalid URL"); the edge build bundles it.
export const runtime = "edge";

// Dynamic favicon — a chrome-star sparkle on the app's near-black, matching the
// brand mark used across the site. Replaces the browser's default globe icon.
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#080808",
          borderRadius: 14,
        }}
      >
        <svg width="42" height="42" viewBox="0 0 100 100" fill="none">
          <path
            d="M50 4 C54 32, 68 46, 96 50 C68 54, 54 68, 50 96 C46 68, 32 54, 4 50 C32 46, 46 32, 50 4 Z"
            fill="#ffffff"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
