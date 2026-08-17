/**
 * The admin allowlist — a pure, dependency-free helper so both `auth.ts` (to
 * flag the session) and `admin.ts` (to guard pages) can use it without a
 * circular import.
 *
 * Access is an env-var allowlist (ADMIN_EMAILS, comma-separated) matched
 * against the signed-in Google account's email. FAIL-CLOSED: if ADMIN_EMAILS is
 * unset, nobody is an admin, so the panel can never accidentally ship open.
 */

/** Parsed, lowercased admin allowlist. Empty when ADMIN_EMAILS is unset. */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True when `email` is on the allowlist. */
export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return adminEmails().includes(email.toLowerCase());
}
