import { eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { decryptSecret, encryptSecret, envelopeKeyId, type Keyring } from "@/lib/crypto";
import { keyring as defaultKeyring } from "./keyring";

/**
 * Re-encrypts every stored integration secret with the CURRENT key. Run after rotating
 * DATA_ENCRYPTION_KEY (with the old key listed in DATA_ENCRYPTION_PREVIOUS_KEYS); afterwards the
 * old key can be removed. Idempotent: envelopes already on the current key are skipped.
 */
export async function reencryptAllSecrets(ring: Keyring = defaultKeyring()) {
  const rows = await db
    .select({ id: integrations.id, secret: integrations.encryptedSecret })
    .from(integrations)
    .where(isNotNull(integrations.encryptedSecret));
  let rotated = 0;
  for (const row of rows) {
    if (!row.secret || envelopeKeyId(row.secret) === ring.currentKeyId) continue;
    const plaintext = decryptSecret(row.secret, ring);
    await db
      .update(integrations)
      .set({ encryptedSecret: encryptSecret(plaintext, ring), updatedAt: new Date() })
      .where(eq(integrations.id, row.id));
    rotated++;
  }
  return { total: rows.length, rotated };
}
