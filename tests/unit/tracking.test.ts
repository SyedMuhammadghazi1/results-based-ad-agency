import { describe, expect, it } from "vitest";
import {
  buildTrackedLandingUrl,
  hasTrackedParams,
  installSnippet,
  isOriginAllowed,
  normalizeOrigin,
  splitUrl,
  TOUCH_RATE_LIMITS,
  touchPayloadSchema,
  trackingUrlTemplate,
} from "@/lib/tracking";

describe("tracking helpers", () => {
  it("normalises origins", () => {
    expect(normalizeOrigin("https://Shop.Example.com/path?x=1")).toBe("https://shop.example.com");
    expect(normalizeOrigin("shop.example.com")).toBe("https://shop.example.com");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
  });

  it("checks allowed origins exactly", () => {
    const allowed = ["https://shop.example.com"];
    expect(isOriginAllowed("https://shop.example.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://evil.example.com", allowed)).toBe(false);
    expect(isOriginAllowed("https://shop.example.com.evil.io", allowed)).toBe(false);
    expect(isOriginAllowed(null, allowed)).toBe(false);
  });

  it("never keeps query strings from page URLs", () => {
    expect(splitUrl("https://shop.example.com/p/1?email=a@b.c#x")).toEqual({
      host: "shop.example.com",
      path: "/p/1",
    });
    expect(splitUrl("not a url")).toEqual({ host: null, path: null });
  });

  it("validates touch payloads", () => {
    const ok = touchPayloadSchema.parse({
      pk: "oa_pk_abcdefgh23",
      vid: "abcdefghijklmnop",
      params: { oa_cid: "x" },
    });
    expect(ok.type).toBe("touch");
    expect(hasTrackedParams(ok.params)).toBe(true);
    expect(hasTrackedParams({})).toBe(false);
    expect(touchPayloadSchema.safeParse({ pk: "nope", vid: "abcdefghijklmnop" }).success).toBe(
      false,
    );
    expect(touchPayloadSchema.safeParse({ pk: "oa_pk_abcdefgh23", vid: "short" }).success).toBe(
      false,
    );
    expect(
      touchPayloadSchema.safeParse({
        pk: "oa_pk_abcdefgh23",
        vid: "abcdefghijklmnop",
        params: { gclid: "x".repeat(501) },
      }).success,
    ).toBe(false);
  });

  it("builds platform tracking templates that always carry oa_cid", () => {
    for (const platform of ["meta", "google", "tiktok"] as const) {
      expect(
        trackingUrlTemplate(platform, "abc123", "https://shop.example.com").template,
      ).toContain("oa_cid=abc123");
    }
    expect(
      trackingUrlTemplate("google", "abc123", "https://x.io").template.startsWith("{lpurl}?"),
    ).toBe(true);
    expect(buildTrackedLandingUrl("https://shop.example.com/p?a=1", "abc")).toBe(
      "https://shop.example.com/p?a=1&oa_cid=abc",
    );
  });

  it("renders the install snippet", () => {
    expect(installSnippet("https://app.example.com/", "oa_pk_x")).toBe(
      '<script async src="https://app.example.com/t.js" data-key="oa_pk_x"></script>',
    );
  });
});

describe("tracking endpoint rate limits", () => {
  it("keeps the per-IP limit far below the per-key limit, so one IP cannot exhaust a site's key", () => {
    const { perIp, perKey } = TOUCH_RATE_LIMITS;
    expect(perIp.windowSec).toBe(perKey.windowSec);
    // One client IP may use at most 5% of a site's per-key budget in any window.
    expect(perIp.limit * 20).toBeLessThanOrEqual(perKey.limit);
    // …while still allowing a busy shared IP (office / carrier NAT) a touch every second.
    expect(perIp.limit / perIp.windowSec).toBeGreaterThanOrEqual(1);
  });
});
