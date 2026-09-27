import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Secrets at rest: AES-256-GCM with a key id prefix so keys can be rotated.
 *
 * Envelope: `enc:v1:<keyId>:<iv b64url>:<tag b64url>:<ciphertext b64url>`
 *
 * The current key encrypts; the current key and any previous keys decrypt. After rotating
 * `DATA_ENCRYPTION_KEY`, run `npm run secrets:rotate` to re-encrypt everything with the new key,
 * then drop the old key from `DATA_ENCRYPTION_PREVIOUS_KEYS`.
 */

export type Keyring = {
  currentKeyId: string;
  keys: Map<string, Buffer>;
};

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

export function buildKeyring(currentKeyId: string, currentKeyB64: string, previous?: string): Keyring {
  const keys = new Map<string, Buffer>();
  const current = Buffer.from(currentKeyB64, "base64");
  if (current.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must decode to 32 bytes");
  keys.set(currentKeyId, current);
  for (const pair of (previous ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const idx = pair.indexOf(":");
    if (idx <= 0) throw new Error("DATA_ENCRYPTION_PREVIOUS_KEYS entries must be keyId:base64Key");
    const id = pair.slice(0, idx);
    const key = Buffer.from(pair.slice(idx + 1), "base64");
    if (key.length !== 32) throw new Error(`Previous key ${id} must decode to 32 bytes`);
    if (!keys.has(id)) keys.set(id, key);
  }
  return { currentKeyId, keys };
}

export function encryptSecret(plaintext: string, keyring: Keyring): string {
  const key = keyring.keys.get(keyring.currentKeyId);
  if (!key) throw new Error("current encryption key missing from keyring");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // Bind the key id into the authenticated data so an envelope can't be relabelled.
  cipher.setAAD(Buffer.from(`v1:${keyring.currentKeyId}`));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["enc", "v1", keyring.currentKeyId, b64u(iv), b64u(tag), b64u(ct)].join(":");
}

export function decryptSecret(envelope: string, keyring: Keyring): string {
  const parts = envelope.split(":");
  if (parts.length !== 6 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new DecryptionError("Unrecognised secret envelope");
  }
  const [, , keyId, ivS, tagS, ctS] = parts as [string, string, string, string, string, string];
  const key = keyring.keys.get(keyId);
  if (!key) throw new DecryptionError(`No key available for key id "${keyId}"`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, fromB64u(ivS));
    decipher.setAAD(Buffer.from(`v1:${keyId}`));
    decipher.setAuthTag(fromB64u(tagS));
    return Buffer.concat([decipher.update(fromB64u(ctS)), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptionError("Secret could not be decrypted (tampered or wrong key)");
  }
}

export function envelopeKeyId(envelope: string): string | null {
  const parts = envelope.split(":");
  return parts.length === 6 && parts[0] === "enc" ? (parts[2] ?? null) : null;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return b64u(randomBytes(bytes));
}

/** Short random code using an unambiguous alphabet (for `oa_cid`, public keys). */
export function randomCode(length: number): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function generatePublicKey(): string {
  return `oa_pk_${randomCode(24)}`;
}

/** Secret server-to-server API key. Only its SHA-256 is stored. */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `oa_sk_${randomToken(32)}`;
  return { key, hash: sha256Hex(key), prefix: key.slice(0, 12) };
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still compare to keep timing roughly constant.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function hmacSha256(secret: string, payload: string | Buffer, encoding: "hex" | "base64") {
  return createHmac("sha256", secret).update(payload).digest(encoding);
}

/** Shopify webhooks: base64(HMAC-SHA256(secret, rawBody)) in `X-Shopify-Hmac-Sha256`. */
export function verifyShopifyHmac(rawBody: string | Buffer, header: string | null, secret: string) {
  if (!header) return false;
  return safeEqual(hmacSha256(secret, rawBody, "base64"), header.trim());
}

/** Signed, expiring state value for OAuth redirects (CSRF protection). */
export function signState(payload: Record<string, string | number>, secret: string): string {
  const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
}

export function verifyState<T extends Record<string, unknown>>(
  state: string,
  secret: string,
  now = Date.now(),
): T | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = b64u(createHmac("sha256", secret).update(body).digest());
  if (!safeEqual(expected, sig)) return null;
  try {
    const parsed = JSON.parse(fromB64u(body).toString("utf8")) as T & { exp?: number };
    if (typeof parsed.exp !== "number" || parsed.exp < now) return null;
    return parsed;
  } catch {
    return null;
  }
}

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64u(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
