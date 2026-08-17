/**
 * Route-level loading UI — shown during navigation/streaming while a server
 * component resolves (e.g. the account/download pages that hit the DB).
 */
export default function Loading() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center" role="status" aria-label="Loading">
      <i className="fa-solid fa-circle-notch animate-spin text-2xl text-accent-solid" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
