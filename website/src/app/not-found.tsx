import type { Metadata } from "next";
import { NotFoundScene } from "@/components/NotFoundScene";

export const metadata: Metadata = {
  title: "404 — lost in the glass · main",
};

/**
 * Custom glass 404. A server shell so it can export `metadata`; the interactive
 * scene (cursor parallax, glitch, drifting ghost widgets, live route trace)
 * lives in the client `NotFoundScene`. Renders inside the root layout, so it
 * sits on the same animated background with the nav + footer.
 */
export default function NotFound() {
  return <NotFoundScene />;
}
