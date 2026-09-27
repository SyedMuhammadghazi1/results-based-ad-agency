import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/t.js/route";

type Sent = { url: string; body: Record<string, unknown> };

async function runScript(
  href: string,
  opts: { cookie?: string; shopify?: boolean; referrer?: string } = {},
) {
  const res = GET();
  expect(res.headers.get("content-type")).toContain("application/javascript");
  const code = await res.text();
  const sent: Sent[] = [];
  const cartUpdates: unknown[] = [];
  const session = new Map<string, string>();
  let cookieJar = opts.cookie ?? "";
  const document = {
    currentScript: {
      src: "https://app.outcome.test/t.js",
      getAttribute: (n: string) => (n === "data-key" ? "oa_pk_abcdefgh23" : null),
    },
    referrer: opts.referrer ?? "",
    get cookie() {
      return cookieJar;
    },
    set cookie(v: string) {
      const [pair] = v.split(";");
      const [name] = pair!.split("=");
      const rest = cookieJar.split("; ").filter((c) => c && !c.startsWith(`${name}=`));
      cookieJar = [...rest, pair].join("; ");
    },
  };
  const window: Record<string, unknown> = {
    crypto: globalThis.crypto,
    sessionStorage: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => session.set(k, v),
    },
    fetch: (url: string, init: { body: string }) => {
      if (url === "/cart/update.js") cartUpdates.push(JSON.parse(init.body));
      else sent.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({});
    },
  };
  if (opts.shopify) window.Shopify = { shop: "acme.myshopify.com" };
  runInNewContext(code, {
    window,
    document,
    location: new URL(href),
    URL,
    Date,
    Math,
    JSON,
    Array,
    Uint8Array,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
  });
  await Promise.resolve();
  return {
    sent,
    cartUpdates,
    cookie: cookieJar,
    api: window.OutcomeAds as { visitorId: () => string },
  };
}

describe("t.js tracking script", () => {
  it("posts a touch with only the tracked parameters and sets a first-party visitor cookie", async () => {
    const { sent, cookie, api } = await runScript(
      "https://shop.example.com/p/1?oa_cid=abc123&utm_source=meta&gclid=G1&email=private@example.com",
      { referrer: "https://l.facebook.com/" },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://app.outcome.test/api/track/touch");
    expect(sent[0]!.body).toMatchObject({
      pk: "oa_pk_abcdefgh23",
      type: "touch",
      params: { oa_cid: "abc123", utm_source: "meta", gclid: "G1" },
    });
    expect(Object.keys(sent[0]!.body.params as object)).not.toContain("email");
    expect(cookie).toMatch(/oa_vid=[0-9a-f]{32}/);
    expect(api.visitorId()).toBe(sent[0]!.body.vid);
  });

  it("reuses an existing visitor id and only pings once per session without parameters", async () => {
    const vid = "existingvisitor0001";
    const first = await runScript("https://shop.example.com/", { cookie: `oa_vid=${vid}` });
    expect(first.sent).toEqual([
      {
        url: "https://app.outcome.test/api/track/touch",
        body: expect.objectContaining({ type: "ping", vid }),
      },
    ]);
  });

  it("stores the visitor id as a Shopify cart attribute on Shopify storefronts", async () => {
    const { cartUpdates, api } = await runScript("https://acme.myshopify.com/?oa_cid=x", {
      shopify: true,
    });
    expect(cartUpdates).toEqual([{ attributes: { oa_vid: api.visitorId() } }]);
  });

  it("is small", async () => {
    expect((await GET().text()).length).toBeLessThan(3_000);
  });
});
