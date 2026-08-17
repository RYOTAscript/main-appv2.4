"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Catches render/data errors in the page tree and
 * shows an on-brand fallback with a retry, instead of a blank screen.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the browser console / any error reporter.
    console.error(error);
  }, [error]);

  return (
    <section className="relative mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-6 text-center">
      <div className="glass glow-strong rounded-3xl border border-white/10 p-10">
        <i className="fa-solid fa-triangle-exclamation mb-4 text-2xl text-accent-solid" />
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Something went wrong.
        </h1>
        <p className="mt-3 text-sm text-neutral-400">
          That page hit a snag on our end. You can try again, or head back home.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-[10px] tracking-wide text-neutral-600">
            ref: {error.digest}
          </p>
        )}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:border-accent/30 hover:bg-white/12"
          >
            <i className="fa-solid fa-rotate-right text-xs" />
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-5 py-2.5 text-sm text-neutral-300 transition-colors hover:text-white"
          >
            Go home
          </a>
        </div>
      </div>
    </section>
  );
}
