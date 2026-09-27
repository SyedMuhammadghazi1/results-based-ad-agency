import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildKeyring,
  decryptSecret,
  DecryptionError,
  encryptSecret,
  envelopeKeyId,
  generateApiKey,
  hmacSha256,
  randomCode,
  safeEqual,
  sha256Hex,
  signState,
  verifyShopifyHmac,
  verifyState,
} from "@/lib/crypto";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");

describe("AES-256-GCM secret envelopes", () => {
  it("round-trips with the key id in the envelope", () => {
    const ring = buildKeyring("k1", k1);
    const env = encryptSecret("shpss_super_secret", ring);
    expect(env.startsWith("enc:v1:k1:")).toBe(true);
    expect(envelopeKeyId(env)).toBe("k1");
    expect(env).not.toContain("shpss_super_secret");
    expect(decryptSecret(env, ring)).toBe("shpss_super_secret");
  });

  it("uses a fresh IV every time", () => {
    const ring = buildKeyring("k1", k1);
    expect(encryptSecret("x", ring)).not.toBe(encryptSecret("x", ring));
  });

  it("decrypts old envelopes after rotation via previous keys", () => {
    const old = encryptSecret("token", buildKeyring("k1", k1));
    const rotated = buildKeyring("k2", k2, `k1:${k1}`);
    expect(decryptSecret(old, rotated)).toBe("token");
    expect(envelopeKeyId(encryptSecret("token", rotated))).toBe("k2");
  });

  it("fails without the right key", () => {
    const old = encryptSecret("token", buildKeyring("k1", k1));
    expect(() => decryptSecret(old, buildKeyring("k2", k2))).toThrow(DecryptionError);
  });

  it("detects tampering, including relabelled key ids", () => {
    const ring = buildKeyring("k1", k1, `k0:${k1}`);
    const env = encryptSecret("token", ring);
    const parts = env.split(":");
    const tampered = [...parts.slice(0, 5), Buffer.from("evil").toString("base64url")].join(":");
    expect(() => decryptSecret(tampered, ring)).toThrow(DecryptionError);
    const relabelled = ["enc", "v1", "k0", ...parts.slice(3)].join(":");
    expect(() => decryptSecret(relabelled, ring)).toThrow(DecryptionError);
    expect(() => decryptSecret("plain", ring)).toThrow(DecryptionError);
  });

  it("validates key material", () => {
    expect(() => buildKeyring("k1", Buffer.from("short").toString("base64"))).toThrow();
    expect(() => buildKeyring("k1", k1, "nocolon")).toThrow();
  });
});

describe("keys and signatures", () => {
  it("generates API keys whose hash (not the key) is stored", () => {
    const { key, hash, prefix } = generateApiKey();
    expect(key).toMatch(/^oa_sk_[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(sha256Hex(key));
    expect(prefix).toBe(key.slice(0, 12));
  });

  it("generates codes from an unambiguous alphabet", () => {
    expect(randomCode(10)).toMatch(/^[a-hjkmnp-z2-9]{10}$/);
  });

  it("verifies Shopify HMAC-SHA256 (base64) against the raw body", () => {
    const body = JSON.stringify({ id: 1, total_price: "10.00" });
    const header = hmacSha256("shh", body, "base64");
    expect(verifyShopifyHmac(body, header, "shh")).toBe(true);
    expect(verifyShopifyHmac(body + " ", header, "shh")).toBe(false);
    expect(verifyShopifyHmac(body, header, "other")).toBe(false);
    expect(verifyShopifyHmac(body, null, "shh")).toBe(false);
  });

  it("compares in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("signs and verifies expiring OAuth state", () => {
    const now = Date.now();
    const s = signState({ orgId: "o1", exp: now + 1000 }, "secret");
    expect(verifyState(s, "secret", now)).toMatchObject({ orgId: "o1" });
    expect(verifyState(s, "wrong", now)).toBeNull();
    expect(verifyState(s, "secret", now + 2000)).toBeNull();
    expect(verifyState(`${s}x`, "secret", now)).toBeNull();
  });
});
