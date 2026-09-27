import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  exchangeGoogleCode,
  GoogleAdsConnector,
  googleAuthorizeUrl,
  refreshGoogleAccessToken,
} from "@/lib/connectors/google";
import { exchangeMetaCode, MetaMarketingConnector, metaAuthorizeUrl } from "@/lib/connectors/meta";
import { ManualConnector, SandboxConnector } from "@/lib/connectors/sandbox";
import { ConnectorError, type FetchLike } from "@/lib/connectors/types";

type Call = { url: string; init?: RequestInit };

function mockFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = vi.fn<FetchLike>(async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fn, calls };
}

const ref = { externalId: "120210000000001", dailyBudgetMinor: 5_000, currency: "USD" };

describe("SandboxConnector", () => {
  it("is deterministic and bounded by the daily budget", async () => {
    const a = new SandboxConnector();
    const b = new SandboxConnector();
    const { externalId } = await a.createCampaign({
      name: "Prospecting",
      objective: "sales",
      dailyBudgetMinor: 5_000,
      currency: "USD",
      landingUrl: "https://x.io",
      trackingCode: "abc",
    });
    expect(externalId).toMatch(/^sbx_[0-9a-f]{16}$/);
    const r = { ...ref, externalId };
    const s1 = await a.fetchDailySpend(r, "2026-09-01", "2026-09-07");
    const s2 = await b.fetchDailySpend(r, "2026-09-01", "2026-09-07");
    expect(s1).toEqual(s2);
    expect(s1).toHaveLength(7);
    for (const d of s1) {
      expect(d.spendMinor).toBeGreaterThanOrEqual(2_750);
      expect(d.spendMinor).toBeLessThanOrEqual(5_000);
    }
    await a.setStatus(r, "paused");
    expect(a.calls.map((c) => c.op)).toEqual(["createCampaign", "fetchDailySpend", "setStatus"]);
  });

  it("ManualConnector never touches the network and asks for manual action", async () => {
    const m = new ManualConnector();
    expect(await m.setStatus()).toEqual({ manual: true });
    expect(await m.fetchDailySpend()).toEqual([]);
  });
});

describe("MetaMarketingConnector", () => {
  const cfg = {
    accessToken: "EAAtoken",
    adAccountId: "act_123456",
    appSecret: "appsecret",
    apiVersion: "v23.0",
  };

  it("creates a paused CBO campaign on the ad account", async () => {
    const { fn, calls } = mockFetch([{ body: { id: "120210000000001" } }]);
    const meta = new MetaMarketingConnector({ ...cfg, fetch: fn });
    const res = await meta.createCampaign({
      name: "Prospecting",
      objective: "sales",
      dailyBudgetMinor: 5_000,
      currency: "USD",
      landingUrl: "https://x.io",
      trackingCode: "abc",
    });
    expect(res).toEqual({ externalId: "120210000000001" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/act_123456/campaigns");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = new URLSearchParams(String(calls[0]!.init?.body));
    expect(body.get("objective")).toBe("OUTCOME_SALES");
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("daily_budget")).toBe("5000");
    expect(body.get("special_ad_categories")).toBe("[]");
    expect(body.get("access_token")).toBe("EAAtoken");
    expect(body.get("appsecret_proof")).toBe(
      createHmac("sha256", "appsecret").update("EAAtoken").digest("hex"),
    );
  });

  it("updates status and budget on the campaign node", async () => {
    const { fn, calls } = mockFetch([{ body: { success: true } }, { body: { success: true } }]);
    const meta = new MetaMarketingConnector({ ...cfg, fetch: fn });
    await meta.setStatus(ref, "paused");
    await meta.setDailyBudget(ref, 7_500);
    expect(calls[0]!.url).toBe(`https://graph.facebook.com/v23.0/${ref.externalId}`);
    expect(new URLSearchParams(String(calls[0]!.init?.body)).get("status")).toBe("PAUSED");
    expect(new URLSearchParams(String(calls[1]!.init?.body)).get("daily_budget")).toBe("7500");
  });

  it("parses daily insights spend across pages", async () => {
    const { fn, calls } = mockFetch([
      {
        body: {
          data: [{ spend: "12.34", date_start: "2026-09-01" }],
          paging: { next: "https://graph.facebook.com/next-page" },
        },
      },
      {
        body: {
          data: [
            { spend: "0.5", date_start: "2026-09-02" },
            { spend: "3", date_start: "2026-09-03" },
          ],
        },
      },
    ]);
    const meta = new MetaMarketingConnector({ ...cfg, fetch: fn });
    const spend = await meta.fetchDailySpend(ref, "2026-09-01", "2026-09-03");
    expect(spend).toEqual([
      { date: "2026-09-01", spendMinor: 1_234 },
      { date: "2026-09-02", spendMinor: 50 },
      { date: "2026-09-03", spendMinor: 300 },
    ]);
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe(`/v23.0/${ref.externalId}/insights`);
    expect(first.searchParams.get("time_increment")).toBe("1");
    expect(JSON.parse(first.searchParams.get("time_range")!)).toEqual({
      since: "2026-09-01",
      until: "2026-09-03",
    });
    expect(calls[1]!.url).toBe("https://graph.facebook.com/next-page");
  });

  it("surfaces Graph API errors as ConnectorError", async () => {
    const { fn } = mockFetch([
      { status: 400, body: { error: { message: "Invalid OAuth access token", code: 190 } } },
    ]);
    const meta = new MetaMarketingConnector({ ...cfg, fetch: fn });
    await expect(meta.setStatus(ref, "active")).rejects.toMatchObject({
      name: "ConnectorError",
      platform: "meta",
      platformCode: 190,
    });
  });

  it("rejects malformed ad account ids before calling the API", async () => {
    const { fn } = mockFetch([]);
    const meta = new MetaMarketingConnector({ ...cfg, adAccountId: "act_../../me", fetch: fn });
    await expect(
      meta.createCampaign({
        name: "x",
        objective: "sales",
        dailyBudgetMinor: 1,
        currency: "USD",
        landingUrl: "https://x.io",
        trackingCode: "a",
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("builds the OAuth dialog URL and exchanges codes for a long-lived token", async () => {
    const url = new URL(
      metaAuthorizeUrl({
        appId: "app1",
        redirectUri: "https://app.io/cb",
        state: "st",
        apiVersion: "v23.0",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
    expect(url.searchParams.get("scope")).toBe("ads_management,ads_read,business_management");
    const { fn, calls } = mockFetch([
      { body: { access_token: "short" } },
      { body: { access_token: "long", expires_in: 5_184_000 } },
    ]);
    const res = await exchangeMetaCode({
      appId: "app1",
      appSecret: "s",
      redirectUri: "https://app.io/cb",
      code: "c",
      apiVersion: "v23.0",
      fetch: fn,
    });
    expect(res).toEqual({ accessToken: "long", expiresIn: 5_184_000 });
    expect(new URL(calls[1]!.url).searchParams.get("grant_type")).toBe("fb_exchange_token");
  });
});

describe("GoogleAdsConnector", () => {
  const base = {
    customerId: "123-456-7890",
    developerToken: "devtoken",
    loginCustomerId: "999-888-7777",
    apiVersion: "v21",
    getAccessToken: async () => "ya29.token",
  };

  it("queries spend with searchStream and converts micros", async () => {
    const { fn, calls } = mockFetch([
      {
        body: [
          { results: [{ segments: { date: "2026-09-01" }, metrics: { costMicros: "12340000" } }] },
          { results: [{ segments: { date: "2026-09-02" }, metrics: { costMicros: "505000" } }] },
        ],
      },
    ]);
    const g = new GoogleAdsConnector({ ...base, fetch: fn });
    const spend = await g.fetchDailySpend(
      { ...ref, externalId: "987654321" },
      "2026-09-01",
      "2026-09-02",
    );
    expect(spend).toEqual([
      { date: "2026-09-01", spendMinor: 1_234 },
      { date: "2026-09-02", spendMinor: 51 },
    ]);
    expect(calls[0]!.url).toBe(
      "https://googleads.googleapis.com/v21/customers/1234567890/googleAds:searchStream",
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ya29.token");
    expect(headers["developer-token"]).toBe("devtoken");
    expect(headers["login-customer-id"]).toBe("9998887777");
    const { query } = JSON.parse(String(calls[0]!.init?.body)) as { query: string };
    expect(query).toBe(
      "SELECT segments.date, metrics.cost_micros FROM campaign WHERE campaign.id = 987654321 AND segments.date BETWEEN '2026-09-01' AND '2026-09-02'",
    );
  });

  it("refuses to build GAQL from unsafe ids or dates", () => {
    const g = new GoogleAdsConnector({ ...base, fetch: mockFetch([]).fn });
    expect(() => g.spendQuery("1 OR 1=1", "2026-09-01", "2026-09-02")).toThrow(ConnectorError);
    expect(() => g.spendQuery("1", "2026-09-01' --", "2026-09-02")).toThrow(ConnectorError);
  });

  it("creates a budget then a paused campaign carrying the oa_cid tracking template", async () => {
    const { fn, calls } = mockFetch([
      { body: { results: [{ resourceName: "customers/1234567890/campaignBudgets/555" }] } },
      { body: { results: [{ resourceName: "customers/1234567890/campaigns/777" }] } },
    ]);
    const g = new GoogleAdsConnector({ ...base, fetch: fn });
    const res = await g.createCampaign({
      name: "Search",
      objective: "sales",
      dailyBudgetMinor: 5_000,
      currency: "USD",
      landingUrl: "https://x.io",
      trackingCode: "abc123",
    });
    expect(res).toEqual({ externalId: "777" });
    const budgetOp = JSON.parse(String(calls[0]!.init?.body)).operations[0].create;
    expect(budgetOp.amountMicros).toBe("50000000");
    const campaignOp = JSON.parse(String(calls[1]!.init?.body)).operations[0].create;
    expect(campaignOp).toMatchObject({
      status: "PAUSED",
      campaignBudget: "customers/1234567890/campaignBudgets/555",
      maximizeConversionValue: {},
    });
    expect(campaignOp.trackingUrlTemplate).toContain("oa_cid=abc123");
  });

  it("pauses via campaigns:mutate with an update mask", async () => {
    const { fn, calls } = mockFetch([{ body: { results: [{}] } }]);
    const g = new GoogleAdsConnector({ ...base, fetch: fn });
    await g.setStatus({ ...ref, externalId: "777" }, "paused");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(calls[0]!.url).toContain("/campaigns:mutate");
    expect(body.operations[0]).toEqual({
      update: { resourceName: "customers/1234567890/campaigns/777", status: "PAUSED" },
      updateMask: "status",
    });
  });

  it("changes the budget after looking up the campaign budget resource", async () => {
    const { fn, calls } = mockFetch([
      {
        body: [
          {
            results: [{ campaign: { campaignBudget: "customers/1234567890/campaignBudgets/555" } }],
          },
        ],
      },
      { body: { results: [{}] } },
    ]);
    const g = new GoogleAdsConnector({ ...base, fetch: fn });
    await g.setDailyBudget({ ...ref, externalId: "777" }, 9_900);
    const body = JSON.parse(String(calls[1]!.init?.body));
    expect(body.operations[0]).toEqual({
      update: {
        resourceName: "customers/1234567890/campaignBudgets/555",
        amountMicros: "99000000",
      },
      updateMask: "amount_micros",
    });
  });

  it("surfaces API errors", async () => {
    const { fn } = mockFetch([
      {
        status: 403,
        body: {
          error: {
            code: 403,
            message: "The developer token is only approved for test accounts",
            status: "PERMISSION_DENIED",
          },
        },
      },
    ]);
    const g = new GoogleAdsConnector({ ...base, fetch: fn });
    await expect(g.setStatus({ ...ref, externalId: "777" }, "active")).rejects.toMatchObject({
      platform: "google",
      status: 403,
      platformCode: "PERMISSION_DENIED",
    });
  });

  it("handles OAuth URL, code exchange and token refresh", async () => {
    const url = new URL(
      googleAuthorizeUrl({ clientId: "cid", redirectUri: "https://app.io/cb", state: "st" }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");

    const ex = mockFetch([{ body: { access_token: "a", refresh_token: "1//refresh" } }]);
    await expect(
      exchangeGoogleCode({
        clientId: "cid",
        clientSecret: "s",
        redirectUri: "https://app.io/cb",
        code: "c",
        fetch: ex.fn,
      }),
    ).resolves.toEqual({ refreshToken: "1//refresh" });
    expect(new URLSearchParams(String(ex.calls[0]!.init?.body)).get("grant_type")).toBe(
      "authorization_code",
    );

    const rf = mockFetch([{ body: { access_token: "ya29.new", expires_in: 3599 } }]);
    await expect(
      refreshGoogleAccessToken({
        clientId: "cid",
        clientSecret: "s",
        refreshToken: "r",
        fetch: rf.fn,
      }),
    ).resolves.toBe("ya29.new");

    const bad = mockFetch([
      {
        status: 400,
        body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
      },
    ]);
    await expect(
      refreshGoogleAccessToken({
        clientId: "cid",
        clientSecret: "s",
        refreshToken: "r",
        fetch: bad.fn,
      }),
    ).rejects.toThrow(/expired or revoked/);
  });
});
