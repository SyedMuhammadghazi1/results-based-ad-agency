import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { GET as cronGET, POST as cronPOST } from "@/app/api/cron/[job]/route";
import { GET as invoiceGET } from "@/app/api/client/invoices/[id]/route";
import { GET as ordersGET } from "@/app/api/client/orders/route";
import { GET as summaryGET } from "@/app/api/client/summary/route";
import { GET as operatorOrgGET } from "@/app/api/operator/orgs/[id]/route";
import { GET as operatorOrgsGET } from "@/app/api/operator/orgs/route";
import { POST as authPOST } from "@/app/api/auth/[...all]/route";
import { GET as oauthStartGET } from "@/app/api/oauth/[provider]/start/route";
import { db } from "@/db";
import { billingPeriods, session, user } from "@/db/schema";
import { runMonthlyBilling } from "@/jobs/monthly-billing";
import { recordConversion } from "@/server/conversions";
import { findOrgByApiKey } from "@/server/orgs";
import { getBillingPeriodForOrg } from "@/server/reports";
import { ingestTouch } from "@/server/tracking";
import {
  activeCampaign,
  createUser,
  getRequest,
  jsonRequest,
  onboardedOrg,
  params,
  PASSWORD,
  SITE,
} from "./helpers";

async function twoOrgs() {
  const ownerA = await createUser("client");
  const ownerB = await createUser("client");
  const operator = await createUser("operator");
  const a = await onboardedOrg(ownerA, { name: "Org A" });
  const b = await onboardedOrg(ownerB, { name: "Org B", website: "https://shop.example-b.test" });
  // Give org B a billed order so it has an invoice.
  const campaign = await activeCampaign(operator, b.org.id);
  const vid = "orgb_visitor_000000000";
  const at = new Date("2026-08-10T10:00:00Z");
  await ingestTouch(
    { pk: b.org.publicKey, vid, type: "touch", params: { oa_cid: campaign.trackingCode } },
    "https://shop.example-b.test",
    new Date(at.getTime() - 60_000),
  );
  await recordConversion(b.org, "api", {
    kind: "conversion",
    externalOrderId: "B-SECRET-1",
    occurredAt: at,
    amountMinor: 77_700,
    currency: "USD",
    visitorId: vid,
  });
  await runMonthlyBilling({ now: new Date("2026-09-01T06:00:00Z"), stripe: null });
  const [invoiceB] = await db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.orgId, b.org.id));
  return { ownerA, ownerB, operator, a, b, invoiceB: invoiceB! };
}

describe("authorization", () => {
  it("anonymous requests get 401 on client and operator APIs", async () => {
    expect((await summaryGET(getRequest("/api/client/summary"))).status).toBe(401);
    expect((await operatorOrgsGET(getRequest("/api/operator/orgs"))).status).toBe(401);
  });

  it("clients cannot access operator routes", async () => {
    const { ownerA, b } = await twoOrgs();
    expect((await operatorOrgsGET(getRequest("/api/operator/orgs", ownerA.headers))).status).toBe(
      403,
    );
    expect(
      (
        await operatorOrgGET(
          getRequest(`/api/operator/orgs/${b.org.id}`, ownerA.headers),
          params({ id: b.org.id }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await oauthStartGET(
          getRequest(`/api/oauth/meta/start?orgId=${b.org.id}`, ownerA.headers),
          params({ provider: "meta" }),
        )
      ).status,
    ).toBe(403);
  });

  it("operators can access operator routes but have no client dashboard", async () => {
    const { operator } = await twoOrgs();
    const res = await operatorOrgsGET(getRequest("/api/operator/orgs", operator.headers));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string; spendMtdMinor: number }>;
    expect(body.map((o) => o.name).sort()).toEqual(["Org A", "Org B"]);
    expect((await summaryGET(getRequest("/api/client/summary", operator.headers))).status).toBe(
      403,
    );
  });

  it("org A cannot read org B's invoice, orders or numbers (IDOR)", async () => {
    const { ownerA, ownerB, a, invoiceB } = await twoOrgs();
    // Direct object reference to B's invoice from A's session → 404 (not even existence leaks).
    const res = await invoiceGET(
      getRequest(`/api/client/invoices/${invoiceB.id}`, ownerA.headers),
      params({ id: invoiceB.id }),
    );
    expect(res.status).toBe(404);
    // B can read it.
    const own = await invoiceGET(
      getRequest(`/api/client/invoices/${invoiceB.id}`, ownerB.headers),
      params({ id: invoiceB.id }),
    );
    expect(own.status).toBe(200);
    expect(await getBillingPeriodForOrg(a.org.id, invoiceB.id)).toBeNull();

    // Orders & summary are scoped to the session's org, whatever the query string says.
    const orders = await (
      await ordersGET(getRequest(`/api/client/orders?orgId=${invoiceB.orgId}`, ownerA.headers))
    ).json();
    expect(orders.rows).toEqual([]);
    const summaryA = await (
      await summaryGET(getRequest(`/api/client/summary?orgId=${invoiceB.orgId}`, ownerA.headers))
    ).json();
    expect(summaryA.last30DaysTotalMinor).toBe(0);
    expect(JSON.stringify(summaryA)).not.toContain("77700");
  });

  it("API keys only authenticate their own org", async () => {
    const { a, b } = await twoOrgs();
    expect((await findOrgByApiKey(a.apiKey))!.id).toBe(a.org.id);
    expect((await findOrgByApiKey(b.apiKey))!.id).toBe(b.org.id);
    expect(await findOrgByApiKey(`${a.apiKey}x`)).toBeNull();
  });

  it("users cannot assign themselves a role at sign-up", async () => {
    const res = await authPOST(
      jsonRequest(
        "/api/auth/sign-up/email",
        {
          email: "sneaky@example.test",
          password: "long-enough-password",
          name: "Sneaky",
          role: "admin",
        },
        { origin: "http://localhost:3003", "x-forwarded-for": "198.51.100.99" },
      ),
    );
    // Better Auth either rejects the field or ignores it — the account must never be staff.
    const rows = await db.select().from(user).where(eq(user.email, "sneaky@example.test"));
    if (res.status === 200) expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.role === "client")).toBe(true);
  });

  it("enforces the minimum password length", async () => {
    const res = await authPOST(
      jsonRequest(
        "/api/auth/sign-up/email",
        { email: "short@example.test", password: "short", name: "Short" },
        { origin: "http://localhost:3003", "x-forwarded-for": "198.51.100.98" },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("rate limits sign-in attempts per IP", async () => {
    let status = 0;
    for (let i = 0; i < 11; i++) {
      status = (
        await authPOST(
          jsonRequest(
            "/api/auth/sign-in/email",
            { email: "nobody@example.test", password: "wrong-password-123" },
            { origin: "http://localhost:3003", "x-forwarded-for": "198.51.100.200" },
          ),
        )
      ).status;
    }
    expect(status).toBe(429);
  });

  const signIn = (email: string, headers: Record<string, string> = {}, password = "wrong-pw-123") =>
    authPOST(
      jsonRequest(
        "/api/auth/sign-in/email",
        { email, password },
        { origin: "http://localhost:3003", ...headers },
      ),
    );

  it("keys the per-IP limit on the proxy's entry, not spoofed X-Forwarded-For entries", async () => {
    // TRUSTED_PROXY_HOPS=1: only the right-most entry was written by our proxy.
    let status = 0;
    for (let i = 0; i < 11; i++) {
      const xff = `10.0.${i}.1, 198.51.100.201`;
      status = (await signIn(`spoof${i}@example.test`, { "x-forwarded-for": xff })).status;
    }
    expect(status).toBe(429);
    const other = await signIn("other@example.test", { "x-forwarded-for": "198.51.100.202" });
    expect(other.status).toBe(401);
  });

  it("rate limits sign-in per account across IPs", async () => {
    let status = 0;
    for (let i = 0; i < 11; i++) {
      const xff = `198.51.100.${10 + i}`;
      status = (
        await signIn(i % 2 ? "Victim@Example.test" : "victim@example.test", {
          "x-forwarded-for": xff,
        })
      ).status;
    }
    expect(status).toBe(429);
    // Other accounts (from the same IPs) are unaffected.
    const other = await signIn("bystander@example.test", { "x-forwarded-for": "198.51.100.10" });
    expect(other.status).toBe(401);
  });

  it("without a trusted client IP, limits sign-in per account instead of one shared bucket", async () => {
    // No X-Forwarded-For at all (e.g. a misconfigured proxy): one attacker must not be able to
    // lock everybody out, but each account is still protected.
    for (let i = 0; i < 15; i++) expect((await signIn(`anyone${i}@example.test`)).status).toBe(401);
    let status = 0;
    for (let i = 0; i < 11; i++) status = (await signIn("target@example.test")).status;
    expect(status).toBe(429);
  });

  it("rate limits password-reset requests per account across IPs", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await authPOST(
        jsonRequest(
          "/api/auth/request-password-reset",
          { email: "reset-me@example.test", redirectTo: "/reset-password" },
          { origin: "http://localhost:3003", "x-forwarded-for": `198.51.100.${60 + i}` },
        ),
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });

  it("records the session IP with the same client-IP resolution", async () => {
    const u = await createUser("client", "ip-check@example.test");
    const res = await signIn(u.email, { "x-forwarded-for": "6.6.6.6, 198.51.100.77" }, PASSWORD);
    expect(res.status).toBe(200);
    const ips = (await db.select().from(session).where(eq(session.userId, u.id))).map(
      (r) => r.ipAddress,
    );
    expect(ips).toContain("198.51.100.77");
    expect(ips).not.toContain("6.6.6.6");
  });

  it("cron endpoints require the CRON_SECRET bearer token", async () => {
    const call = (auth?: string, job = "cleanup") =>
      cronPOST(
        new Request(`http://localhost:3003/api/cron/${job}`, {
          method: "POST",
          headers: auth ? { authorization: auth } : {},
        }),
        params({ job }),
      );
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong-secret-000000000")).status).toBe(401);
    expect((await call(`Bearer ${process.env.CRON_SECRET}`, "nope")).status).toBe(404);
    const ok = await call(`Bearer ${process.env.CRON_SECRET}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, job: "cleanup" });
    // Vercel Cron uses GET with the same header.
    const viaGet = await cronGET(
      new Request("http://localhost:3003/api/cron/cleanup", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
      params({ job: "cleanup" }),
    );
    expect(viaGet.status).toBe(200);
    expect(SITE).toBeTruthy();
  });
});
