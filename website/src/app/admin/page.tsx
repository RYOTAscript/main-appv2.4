import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { DeleteLicenseButton } from "@/components/admin/DeleteLicenseButton";
import { ResetDevicesButton } from "@/components/admin/ResetDevicesButton";
import { PurchaseRevenueToggle } from "@/components/admin/PurchaseRevenueToggle";
import {
  requireAdmin,
  getAdminStats,
  getAdminCustomers,
  getRecentPurchases,
  formatMoney,
} from "@/lib/admin";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass rounded-2xl border border-white/10 px-6 py-5">
      <p className="text-xs uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-white">{value}</p>
    </div>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const session = await requireAdmin();
  if (!session) redirect("/");

  const search = searchParams.q ?? "";
  const [stats, customers, purchases] = await Promise.all([
    getAdminStats(),
    getAdminCustomers(search),
    getRecentPurchases(),
  ]);

  return (
    <section className="relative mx-auto max-w-6xl px-6 pb-24 pt-32">
      <div className="mb-8">
        <SectionLabel>ADMIN</SectionLabel>
        <h1 className="mt-2 text-2xl font-semibold text-white">Dashboard</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Signed in as {session.user?.email}
        </p>
      </div>

      {/* Headline stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Users" value={String(stats.users)} />
        <Stat label="Active licenses" value={String(stats.activeLicenses)} />
        <Stat label="Revenue" value={formatMoney(stats.revenueCents)} />
        <Stat label="Sales this month" value={String(stats.salesThisMonth)} />
        <Stat
          label="Revenue this month"
          value={formatMoney(stats.revenueThisMonthCents)}
        />
      </div>

      {/* Customers */}
      <div className="mt-12">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <SectionLabel>CUSTOMERS</SectionLabel>
          <form method="get" className="flex items-center gap-2">
            <input
              type="text"
              name="q"
              defaultValue={search}
              placeholder="Search email or name…"
              className="w-64 rounded-xl border border-white/12 bg-white/[0.04] px-3.5 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-white/25 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-xl border border-white/12 bg-white/[0.08] px-4 py-2 text-sm text-white transition-colors hover:bg-white/15"
            >
              Search
            </button>
          </form>
        </div>

        <div className="glass overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">License</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Devices</th>
                <th className="px-4 py-3 font-medium">Spent</th>
                <th className="px-4 py-3 font-medium">Joined</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center text-neutral-500"
                  >
                    No customers found.
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3 text-white">{c.email ?? "—"}</td>
                    <td className="px-4 py-3 text-neutral-300">
                      {c.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-300">
                      {c.licenseKey ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {c.licenseKey ? (
                        <span
                          className={
                            c.licenseActive
                              ? "text-emerald-400"
                              : "text-neutral-500"
                          }
                        >
                          {c.licenseActive ? "Active" : "Inactive"}
                        </span>
                      ) : (
                        <span className="text-neutral-600">None</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-neutral-300">
                      {c.deviceCount}
                    </td>
                    <td className="px-4 py-3 text-neutral-300">
                      {c.spentCents > 0 ? formatMoney(c.spentCents) : "—"}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">
                      {fmtDate(c.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {c.licenseId && c.licenseKey ? (
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <ResetDevicesButton
                            licenseId={c.licenseId}
                            deviceCount={c.deviceCount}
                          />
                          <DeleteLicenseButton
                            licenseId={c.licenseId}
                            licenseKey={c.licenseKey}
                          />
                        </div>
                      ) : (
                        <span className="text-neutral-600">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Showing up to 100 rows{search ? ` matching “${search}”` : ""}.
        </p>
      </div>

      {/* Recent purchases */}
      <div className="mt-12">
        <SectionLabel>RECENT PURCHASES</SectionLabel>
        <div className="glass mt-4 overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Provider</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Order ID</th>
                <th className="px-4 py-3 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {purchases.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-neutral-500"
                  >
                    No purchases yet.
                  </td>
                </tr>
              ) : (
                purchases.map((p) => (
                  <tr
                    key={p.id}
                    className={`border-b border-white/5 last:border-0 hover:bg-white/[0.02] ${
                      p.counts ? "" : "opacity-60"
                    }`}
                  >
                    <td className="px-4 py-3 text-neutral-400">
                      {fmtDate(p.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-white">{p.email ?? "—"}</td>
                    <td
                      className={`px-4 py-3 text-neutral-300 ${
                        p.counts ? "" : "line-through"
                      }`}
                    >
                      {formatMoney(p.amountCents, p.currency)}
                    </td>
                    <td className="px-4 py-3 capitalize text-neutral-300">
                      {p.provider}
                    </td>
                    <td className="px-4 py-3 text-neutral-300">
                      {p.counts ? (
                        <span className="capitalize">{p.status}</span>
                      ) : (
                        <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
                          Excluded
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-500">
                      {p.externalId}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <PurchaseRevenueToggle
                          purchaseId={p.id}
                          counts={p.counts}
                        />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
