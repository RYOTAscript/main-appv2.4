import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `main — ${SITE.tagline}`,
    short_name: "main",
    description: SITE.description,
    start_url: "/",
    display: "standalone",
    background_color: "#080808",
    theme_color: "#080808",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/logo.png", sizes: "any", type: "image/png", purpose: "any" },
    ],
  };
}
