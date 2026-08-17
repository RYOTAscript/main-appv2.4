import { prisma } from "@/lib/prisma";

/**
 * Per-key device binding + limit.
 *
 * A license may be activated on up to LICENSE_DEVICE_LIMIT distinct machines
 * (default 2). This is what stops one purchased key from unlocking the app on
 * unlimited machines (copy-the-license-file / share-the-key abuse). Users who
 * hit the limit legitimately (new PC, etc.) can free their slots from the
 * account page via resetDevices().
 *
 * Reclaiming: a genuine user who reinstalls Windows gets a new machine
 * fingerprint, which would otherwise burn a slot forever. So when a NEW machine
 * arrives at the limit, we evict the stalest activation IF it hasn't been seen
 * in LICENSE_ACTIVATION_STALE_DAYS (default 14) — reinstalls keep working, but a
 * key actively in use on N machines can't spread to an (N+1)th.
 */

export const DEVICE_LIMIT = Math.max(1, Number(process.env.LICENSE_DEVICE_LIMIT || 2));
const STALE_MS =
  Math.max(1, Number(process.env.LICENSE_ACTIVATION_STALE_DAYS || 14)) *
  24 *
  60 *
  60 *
  1000;

// Minimum time between HWID resets (default 14 days). Comfortably longer than
// the offline grace window, so resets can't be looped to run many machines at
// once off one license, while still letting a genuine user reset when they
// actually change PCs. DB-enforced (License.lastResetAt) so it holds across
// serverless instances.
export const RESET_COOLDOWN_MS =
  Math.max(1, Number(process.env.LICENSE_RESET_COOLDOWN_DAYS || 14)) *
  24 *
  60 *
  60 *
  1000;

export type ActivationResult =
  | { ok: true; created: boolean; priorCount: number }
  | { ok: false; reason: "device-limit" };

function cleanName(name?: string): string | null {
  const n = (name || "").trim().slice(0, 64);
  return n || null;
}

/**
 * Register (or refresh) an activation for this license+machine, enforcing the
 * device limit. Returns { ok:false, reason:'device-limit' } when a brand-new
 * machine would exceed the cap and no stale slot can be reclaimed. On success,
 * `created` says whether this was a brand-new device (vs a refresh) and
 * `priorCount` is how many devices existed before it — the caller uses those to
 * decide whether to fire a "new device" alert.
 */
export async function registerActivation(
  licenseId: string,
  machineId: string,
  deviceName?: string,
): Promise<ActivationResult> {
  const name = cleanName(deviceName);
  const existing = await prisma.activation.findUnique({
    where: { licenseId_machineId: { licenseId, machineId } },
  });

  // Known machine → refresh lastSeen (and name, in case the hostname changed).
  if (existing) {
    await prisma.activation.update({
      where: { id: existing.id },
      data: { lastSeen: new Date(), ...(name ? { name } : {}) },
    });
    return { ok: true, created: false, priorCount: 0 };
  }

  // New machine → enforce the cap, reclaiming a stale slot if possible.
  const all = await prisma.activation.findMany({
    where: { licenseId },
    orderBy: { lastSeen: "asc" },
  });
  const priorCount = all.length;

  if (all.length >= DEVICE_LIMIT) {
    const stalest = all[0];
    const isStale =
      stalest && Date.now() - stalest.lastSeen.getTime() > STALE_MS;
    if (!isStale) return { ok: false, reason: "device-limit" };
    // Reclaim the stalest slot for this new machine.
    await prisma.activation.delete({ where: { id: stalest.id } });
  }

  await prisma.activation.create({ data: { licenseId, machineId, name } });
  return { ok: true, created: true, priorCount };
}

export type DeviceInfo = {
  id: string;
  /** The PC's hostname, when the app reported one. */
  name: string | null;
  /** Short, human-readable fingerprint (first 8 chars of the machine hash). */
  shortId: string;
  firstSeen: string;
  lastSeen: string;
};

export type DeviceSummary = {
  limit: number;
  used: number;
  devices: DeviceInfo[];
  /** Ms until a reset is allowed again (0 = allowed now). */
  resetInMs: number;
};

function resetInMs(lastResetAt: Date | null): number {
  if (!lastResetAt) return 0;
  const remaining = RESET_COOLDOWN_MS - (Date.now() - lastResetAt.getTime());
  return remaining > 0 ? remaining : 0;
}

/** The activated-device summary for a user's license (for the account page). */
export async function getLicenseDevices(userId: string): Promise<DeviceSummary> {
  const license = await prisma.license.findUnique({ where: { userId } });
  if (!license) return { limit: DEVICE_LIMIT, used: 0, devices: [], resetInMs: 0 };

  const rows = await prisma.activation.findMany({
    where: { licenseId: license.id },
    orderBy: { lastSeen: "desc" },
  });

  return {
    limit: DEVICE_LIMIT,
    used: rows.length,
    resetInMs: resetInMs(license.lastResetAt),
    devices: rows.map((r) => ({
      id: r.id,
      name: r.name ?? null,
      shortId: r.machineId.slice(0, 8).toUpperCase(),
      firstSeen: r.firstSeen.toISOString(),
      lastSeen: r.lastSeen.toISOString(),
    })),
  };
}

export type ResetResult =
  | { ok: true; removed: number }
  | { ok: false; reason: "cooldown"; retryInMs: number };

/**
 * Clear ALL device activations for a user's license (a "HWID reset"), subject to
 * a DB-enforced cooldown (RESET_COOLDOWN_MS). The next launch on each machine
 * simply re-activates and re-fills the freed slots — so this is the self-serve
 * fix when a user has changed PCs and hit the limit. The cooldown stops resets
 * from being looped to stack machines past the device limit within the offline
 * grace window.
 */
export async function resetDevices(userId: string): Promise<ResetResult> {
  const license = await prisma.license.findUnique({ where: { userId } });
  if (!license) return { ok: true, removed: 0 };

  const remaining = resetInMs(license.lastResetAt);
  if (remaining > 0) return { ok: false, reason: "cooldown", retryInMs: remaining };

  const { count } = await prisma.activation.deleteMany({
    where: { licenseId: license.id },
  });
  await prisma.license.update({
    where: { id: license.id },
    data: { lastResetAt: new Date() },
  });
  return { ok: true, removed: count };
}

/**
 * Admin/support reset by licenseId — same effect as resetDevices (clears
 * activations + stamps lastResetAt so devices log out on next launch) but with
 * NO cooldown, for when support needs to unstick a customer. Returns the number
 * of devices removed.
 */
export async function resetDevicesByLicense(licenseId: string): Promise<number> {
  const { count } = await prisma.activation.deleteMany({ where: { licenseId } });
  await prisma.license.update({
    where: { id: licenseId },
    data: { lastResetAt: new Date() },
  });
  return count;
}
