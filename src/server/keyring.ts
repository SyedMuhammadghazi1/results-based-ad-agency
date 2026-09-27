import { env } from "@/env";
import { buildKeyring, decryptSecret, encryptSecret, type Keyring } from "@/lib/crypto";

let cached: Keyring | null = null;

export function keyring(): Keyring {
  if (!cached) {
    if (!env.DATA_ENCRYPTION_KEY) throw new Error("DATA_ENCRYPTION_KEY is not configured");
    cached = buildKeyring(
      env.DATA_ENCRYPTION_KEY_ID,
      env.DATA_ENCRYPTION_KEY,
      env.DATA_ENCRYPTION_PREVIOUS_KEYS,
    );
  }
  return cached;
}

export const encrypt = (plaintext: string) => encryptSecret(plaintext, keyring());
export const decrypt = (envelope: string) => decryptSecret(envelope, keyring());
