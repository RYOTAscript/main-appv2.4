import { prisma } from "@/lib/prisma";
import { generateLicenseKey } from "@/lib/license";

/**
 * Record a payment and provision the user's license — idempotently.
 *
 * Idempotency is keyed on `externalId` (the processor's order id): if we've
 * already recorded that order, this is a no-op. There is at most one active
 * license per user. Safe to call from both the synchronous capture route and an
 * asynchronous webhook (whichever lands first wins; the other no-ops).
 */
export async function provisionLicense(input: {
  userId: string;
  provider: string; // "paypal"
  externalId: string; // order id — the idempotency key
  captureId?: string | null;
  amountCents: number;
  currency: string;
}): Promise<void> {
  const existing = await prisma.purchase.findUnique({
    where: { externalId: input.externalId },
  });
  if (existing) return;

  await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction to guard against concurrent callers.
    const dupe = await tx.purchase.findUnique({
      where: { externalId: input.externalId },
    });
    if (dupe) return;

    await tx.purchase.create({
      data: {
        userId: input.userId,
        provider: input.provider,
        externalId: input.externalId,
        captureId: input.captureId ?? null,
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        status: "complete",
      },
    });

    // One active license per user; keep an existing one if somehow present.
    const current = await tx.license.findUnique({
      where: { userId: input.userId },
    });
    if (!current) {
      let key = generateLicenseKey();
      for (let i = 0; i < 5; i++) {
        const clash = await tx.license.findUnique({ where: { key } });
        if (!clash) break;
        key = generateLicenseKey();
      }
      await tx.license.create({
        data: { userId: input.userId, key, active: true },
      });
    }
  });
}
