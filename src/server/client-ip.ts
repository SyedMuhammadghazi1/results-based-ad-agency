import { env } from "@/env";
import { resolveClientIp } from "@/lib/client-ip";
import { logger } from "./logger";

let warned = false;

/**
 * The request's client IP according to `CLIENT_IP_HEADER` / `TRUSTED_PROXY_HOPS`, or `null` when
 * no trustworthy address is available. Use this everywhere an IP is needed (rate limits, audit
 * log, agreement acceptance, Better Auth sessions) — never read forwarding headers directly.
 */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  const ip = resolveClientIp(headers, {
    header: env.CLIENT_IP_HEADER,
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
  });
  if (!ip && !warned) {
    warned = true;
    logger.warn(
      { clientIpHeader: env.CLIENT_IP_HEADER ?? null, trustedProxyHops: env.TRUSTED_PROXY_HOPS },
      "could not resolve a trusted client IP; per-IP rate limits fall back to account/key limits " +
        "— check CLIENT_IP_HEADER / TRUSTED_PROXY_HOPS (docs/DEPLOYMENT.md)",
    );
  }
  return ip;
}
