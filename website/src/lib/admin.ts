import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdminEmail } from "@/lib/adminEmails";

export { isAdminEmail };

/**
 * Admin panel access control + read queries.
 *
 * Access is an env-var allowlist (ADMIN_EMAILS, comma-separated) matched
 * against the signed-in Google account's email — see `adminEmails.ts`. No DB
 * schema change and no admin field on User; the list of owners is tiny and
 * lives in config. Fail-closed: unset ADMIN_EMAILS ⇒ nobody is admin.
 */

/**
 * The current session IF it belongs to an admin, else null. Page/route guards
 * call this and redirect on null.
 */
export async function requireAdmin() {
  const session = await auth();
  if (!session?.user || !isAdminEmail(session.user.email)) return null;
  return session;
}

// ── Dashboard data ─────────────────────────────────────────────────────────

export type AdminStats = {
  users: number;
  activeLicenses: number;
  /** Lifetime revenue across completed purchases, in the smallest unit (cents). */
  revenueCents: number;
  /** Completed purchases in the current calendar month. */
  salesThisMonth: number;
  revenueThisMonthCents: number;
};

/** Headline counters for the top of the dashboard. */
export async function getAdminStats(): Promise<AdminStats> {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [users, activeLicenses, revenue, monthAgg] = await Promise.all([
    prisma.user.count(),
    prisma.license.count({ where: { active: true } }),
    prisma.purchase.aggregate({
      where: { status: "complete" },
      _sum: { amount: true },
    }),
    prisma.purchase.aggregate({
      where: { status: "complete", createdAt: { gte: startOfMonth } },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  return {
    users,
    activeLicenses,
    revenueCents: revenue._sum.amount ?? 0,
    salesThisMonth: monthAgg._count,
    revenueThisMonthCents: monthAgg._sum.amount ?? 0,
  };
}

export type AdminCustomer = {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  licenseId: string | null;
  licenseKey: string | null;
  licenseActive: boolean;
  deviceCount: number;
  purchaseCount: number;
  spentCents: number;
};

/**
 * Customer rows for the dashboard table, newest signups first. `search`
 * filters by email/name substring (case-insensitive). Capped at `take` rows.
 */
export async function getAdminCustomers(
  search = "",
  take = 100,
): Promise<AdminCustomer[]> {
  const q = search.trim();
  const users = await prisma.user.findMany({
    where: q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
    take,
    include: {
      license: { include: { _count: { select: { activations: true } } } },
      purchases: { where: { status: "complete" }, select: { amount: true } },
    },
  });

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    createdAt: u.createdAt.toISOString(),
    licenseId: u.license?.id ?? null,
    licenseKey: u.license?.key ?? null,
    licenseActive: Boolean(u.license?.active),
    deviceCount: u.license?._count.activations ?? 0,
    purchaseCount: u.purchases.length,
    spentCents: u.purchases.reduce((sum, p) => sum + p.amount, 0),
  }));
}

export type AdminPurchase = {
  id: string;
  createdAt: string;
  email: string | null;
  amountCents: number;
  currency: string;
  provider: string;
  status: string;
  /** Whether this purchase counts toward revenue (status === "complete"). */
  counts: boolean;
  externalId: string;
};

/** The most recent purchases across all users. */
export async function getRecentPurchases(take = 25): Promise<AdminPurchase[]> {
  const rows = await prisma.purchase.findMany({
    orderBy: { createdAt: "desc" },
    take,
    include: { user: { select: { email: true } } },
  });

  return rows.map((p) => ({
    id: p.id,
    createdAt: p.createdAt.toISOString(),
    email: p.user.email,
    amountCents: p.amount,
    currency: p.currency,
    provider: p.provider,
    status: p.status,
    counts: p.status === "complete",
    externalId: p.externalId,
  }));
}

/** Format a smallest-unit amount (cents) as a currency string, e.g. "$5.00". */
export function formatMoney(cents: number, currency = "usd"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
