import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

/**
 * Generate a cryptographically-random license key in the form
 * MAIN-XXXX-XXXX-XXXX-XXXX (Crockford-ish base32, ambiguous chars removed).
 */
export function generateLicenseKey(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I,L,O,0,1
  const bytes = randomBytes(16);
  const groups: string[] = [];
  let idx = 0;
  for (let g = 0; g < 4; g++) {
    let group = "";
    for (let c = 0; c < 4; c++) {
      group += alphabet[bytes[idx++] % alphabet.length];
    }
    groups.push(group);
  }
  return `MAIN-${groups.join("-")}`;
}

/** The user's license row, or null. */
export function getUserLicense(userId: string) {
  return prisma.license.findUnique({ where: { userId } });
}

/** True when the user holds an active license. */
export async function hasActiveLicense(userId: string): Promise<boolean> {
  const license = await prisma.license.findUnique({ where: { userId } });
  return Boolean(license?.active);
}
