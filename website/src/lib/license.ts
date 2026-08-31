import { randomInt } from "crypto";
import { prisma } from "@/lib/prisma";

/**
 * Generate a cryptographically-random license key in the form
 * MAIN-XXXX-XXXX-XXXX-XXXX (Crockford-ish base32, ambiguous chars removed).
 *
 * Uses randomInt rather than `randomBytes()[i] % alphabet.length`: 256 is not a
 * multiple of 31, so the modulo form made the first eight characters ~12% more
 * likely than the rest. Never enough bias to threaten a 16-character key (~79
 * bits either way), but uniform selection costs nothing. Existing keys are
 * unaffected — the format and alphabet are unchanged.
 */
export function generateLicenseKey(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I,L,O,0,1
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = "";
    for (let c = 0; c < 4; c++) {
      group += alphabet[randomInt(alphabet.length)];
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
