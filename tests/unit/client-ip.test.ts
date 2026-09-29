import { describe, expect, it } from "vitest";
import { ipRateLimitKey, normalizeIp, resolveClientIp } from "@/lib/client-ip";

const h = (init: Record<string, string>) => new Headers(init);
const hops = (trustedProxyHops: number) => ({ trustedProxyHops });

describe("resolveClientIp — X-Forwarded-For with trusted proxy hops", () => {
  it("ignores client-supplied (spoofed) entries left of the trusted hops", () => {
    const headers = h({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 198.51.100.7" });
    expect(resolveClientIp(headers, hops(1))).toBe("198.51.100.7");
    // A client that sends its own header only prepends; the proxy's entry stays last.
    expect(resolveClientIp(h({ "x-forwarded-for": "10.0.0.1, 198.51.100.7" }), hops(1))).toBe(
      "198.51.100.7",
    );
  });

  it("takes the entry `hops` positions from the right", () => {
    const headers = h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2" });
    expect(resolveClientIp(headers, hops(1))).toBe("10.0.0.2");
    expect(resolveClientIp(headers, hops(2))).toBe("203.0.113.9");
    expect(resolveClientIp(headers, hops(3))).toBe("6.6.6.6");
    expect(resolveClientIp(h({ "x-forwarded-for": "198.51.100.7" }), hops(1))).toBe("198.51.100.7");
  });

  it("returns null when there are fewer entries than hops, no header, or hops = 0", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "198.51.100.7" }), hops(2))).toBeNull();
    expect(resolveClientIp(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), hops(3))).toBeNull();
    expect(resolveClientIp(h({}), hops(1))).toBeNull();
    expect(resolveClientIp(h({ "x-forwarded-for": "198.51.100.7" }), hops(0))).toBeNull();
  });

  it("never falls back to another header or entry when the chosen one is invalid", () => {
    const headers = h({ "x-forwarded-for": "198.51.100.7, unknown", "x-real-ip": "203.0.113.1" });
    expect(resolveClientIp(headers, hops(1))).toBeNull();
    expect(resolveClientIp(h({ "x-forwarded-for": "198.51.100.7," }), hops(1))).toBeNull();
    expect(resolveClientIp(h({ "x-real-ip": "203.0.113.1" }), hops(1))).toBeNull();
  });
});

describe("resolveClientIp — single platform header (CLIENT_IP_HEADER)", () => {
  const cfg = { header: "x-real-ip", trustedProxyHops: 1 };

  it("uses only that header (first value, trimmed) and ignores X-Forwarded-For", () => {
    const headers = h({ "x-real-ip": " 203.0.113.9 ", "x-forwarded-for": "6.6.6.6, 7.7.7.7" });
    expect(resolveClientIp(headers, cfg)).toBe("203.0.113.9");
    expect(resolveClientIp(h({ "x-real-ip": "203.0.113.9, 6.6.6.6" }), cfg)).toBe("203.0.113.9");
  });

  it("returns null when the header is missing or invalid (no fallback to X-Forwarded-For)", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "198.51.100.7" }), cfg)).toBeNull();
    expect(resolveClientIp(h({ "x-real-ip": "not-an-ip" }), cfg)).toBeNull();
    expect(
      resolveClientIp(h({ "cf-connecting-ip": "2001:db8::1" }), {
        header: "cf-connecting-ip",
        trustedProxyHops: 0,
      }),
    ).toBe("2001:db8::1");
  });
});

describe("normalizeIp", () => {
  it("rejects anything that is not an IP address", () => {
    for (const v of [
      "",
      "   ",
      "unknown",
      "localhost",
      "1.2.3",
      "1.2.3.999",
      "256.1.1.1",
      "1.2.3.4.5",
      "<script>",
      "1.2.3.4 5.6.7.8",
      "::g",
      "a".repeat(500),
      null,
      undefined,
    ]) {
      expect(normalizeIp(v)).toBeNull();
    }
  });

  it("accepts IPv4, optionally with a port", () => {
    expect(normalizeIp("198.51.100.7")).toBe("198.51.100.7");
    expect(normalizeIp(" 198.51.100.7:51234 ")).toBe("198.51.100.7");
  });

  it("handles IPv6: case, brackets/port, zone ids and IPv4-mapped addresses", () => {
    expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeIp("::1")).toBe("::1");
    expect(normalizeIp("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(normalizeIp("::FFFF:c633:6407")).toBe("198.51.100.7");
    expect(normalizeIp("::ffff:999.1.1.1")).toBeNull();
  });
});

describe("ipRateLimitKey", () => {
  it("keys IPv4 by address", () => {
    expect(ipRateLimitKey("198.51.100.7")).toBe("198.51.100.7");
  });

  it("keys IPv6 by /64 so address rotation inside one allocation shares a bucket", () => {
    const key = ipRateLimitKey("2001:db8:1:2:3:4:5:6");
    expect(key).toBe("2001:db8:1:2::/64");
    expect(ipRateLimitKey("2001:db8:1:2:ffff::1")).toBe(key);
    expect(ipRateLimitKey("2001:db8:1:3::1")).not.toBe(key);
    expect(ipRateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipRateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(ipRateLimitKey("64:ff9b::198.51.100.7")).toBe("64:ff9b:0:0::/64");
    expect(ipRateLimitKey("1:2:3:4:5:6:198.51.100.7")).toBe("1:2:3:4::/64");
  });
});
