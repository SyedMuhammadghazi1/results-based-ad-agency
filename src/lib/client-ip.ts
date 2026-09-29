import { isIP } from "node:net";

/**
 * Client IP resolution — the ONLY code that reads `X-Forwarded-For`. Used for rate limits, the
 * audit log, agreement acceptance and Better Auth sessions (via `server/client-ip.ts`).
 *
 * - `header` set (`CLIENT_IP_HEADER`): trust only that single header, which the hosting platform
 *   sets and clients cannot spoof (`x-real-ip` on Vercel, `fly-client-ip`, `cf-connecting-ip`).
 * - otherwise `trustedProxyHops` (`TRUSTED_PROXY_HOPS`, default 1): every proxy APPENDS to
 *   `X-Forwarded-For`, so only the right-most `hops` entries were written by infrastructure we
 *   trust; the entry `hops` positions from the right is the client. Anything to its left is
 *   client-controlled. `0` never trusts the header.
 *
 * Returns `null` when no trustworthy, syntactically valid IP is available.
 */

export const FORWARDED_FOR_HEADER = "x-forwarded-for";

/** Headers that can never be `CLIENT_IP_HEADER`: they are lists clients can prepend to. */
export const SPOOFABLE_IP_HEADERS: readonly string[] = [FORWARDED_FOR_HEADER, "forwarded"];

export type ClientIpConfig = {
  header?: string | undefined;
  trustedProxyHops: number;
};

type HeaderSource = { get(name: string): string | null };

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Validates one address (`net.isIP`), dropping a port, brackets, an IPv6 zone and `::ffff:`. */
export function normalizeIp(value: string | null | undefined): string | null {
  let v = value?.trim() ?? "";
  if (!v) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(v);
  if (bracketed) v = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));
  const zone = v.indexOf("%");
  if (zone !== -1) v = v.slice(0, zone);
  const kind = isIP(v);
  if (kind === 0) return null;
  if (kind === 4) return v;
  v = v.toLowerCase();
  // IPv4-mapped IPv6 (dual-stack sockets): the client is the IPv4 address.
  if (v.startsWith("::ffff:")) {
    const rest = v.slice(7);
    if (IPV4.test(rest) && isIP(rest) === 4) return rest;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
    }
  }
  return v;
}

export function resolveClientIp(headers: HeaderSource, config: ClientIpConfig): string | null {
  if (config.header) {
    return normalizeIp(headers.get(config.header)?.split(",")[0]);
  }
  const hops = config.trustedProxyHops;
  if (!Number.isSafeInteger(hops) || hops <= 0) return null;
  const xff = headers.get(FORWARDED_FOR_HEADER);
  if (!xff) return null;
  const entries = xff.split(",").map((e) => e.trim());
  if (entries.length < hops) return null;
  return normalizeIp(entries[entries.length - hops]);
}

/** The 8 16-bit groups of a valid IPv6 address (handles `::` and an embedded IPv4 tail). */
function ipv6Groups(ip: string): number[] {
  let s = ip;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill("0");
  return [...h, ...zeros, ...t].map((g) => parseInt(g, 16));
}

/**
 * Rate-limit key for a (normalized) client IP. IPv6 clients are keyed by their /64 — the usual
 * allocation of a single subscriber — so rotating addresses inside it does not reset the limit.
 */
export function ipRateLimitKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const prefix = ipv6Groups(ip)
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":");
  return `${prefix}::/64`;
}
