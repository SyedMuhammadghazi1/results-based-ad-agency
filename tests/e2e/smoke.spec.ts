import { expect, test } from "@playwright/test";

/**
 * Primary happy path: a client signs up, onboards and accepts the performance agreement; an
 * operator launches a campaign; a tracked ad click and an order arrive through the public APIs;
 * the client's dashboard shows the attributed revenue number.
 */
test("client onboarding → tracked order → revenue on the dashboard", async ({
  page,
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `founder+${stamp}@e2e-outfitters.test`;
  const site = "https://shop.e2e-outfitters.test";

  // --- Public site → sign up ---------------------------------------------------------
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("pay for themselves");
  await page.getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(/\/sign-up/);
  await page.getByLabel("Full name").fill("Fran Founder");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("a-very-long-password-1");
  await page.getByRole("button", { name: "Create account" }).click();

  // --- Onboarding ----------------------------------------------------------------------
  await expect(page).toHaveURL(/\/onboarding\/organization/);
  await page.getByLabel("Company name").fill(`E2E Outfitters ${stamp}`);
  await page.getByRole("button", { name: "Create organization" }).click();

  await expect(page).toHaveURL(/\/onboarding\/intake/);
  await page.getByLabel("Website").fill(site);
  await page.getByLabel("Product / offer").fill("Waterproof backpacks for city cyclists.");
  await page.getByLabel("Average order value (USD)").fill("80");
  await page.getByLabel("Gross margin (%)").fill("50");
  await page.getByLabel("Monthly ad spend cap (USD)").fill("5000");
  await page.getByLabel("Target countries / regions").fill("US, CA");
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page).toHaveURL(/\/onboarding\/agreement/);
  await expect(page.locator("pre")).toContainText("You pay 10% of Attributed Revenue");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Accept agreement" }).click();

  await expect(page).toHaveURL(/\/onboarding\/tracking/);
  const snippet = await page.getByLabel("Tracking snippet").inputValue();
  const publicKey = /data-key="(oa_pk_[a-z0-9]+)"/.exec(snippet)![1]!;
  await page.getByText("Server-to-server API").click();
  await page.getByRole("button", { name: "Create API key" }).click();
  const apiKey = await page.getByLabel("Secret value").inputValue();
  expect(apiKey).toMatch(/^oa_sk_/);

  await page.getByRole("link", { name: "Continue to payment method" }).click();
  await expect(page).toHaveURL(/\/onboarding\/payment/);
  await page.getByRole("link", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("revenue-this-month")).toHaveText("$0.00");

  // --- Operator launches a campaign for the new client -----------------------------------
  const opContext = await browser.newContext();
  const op = await opContext.newPage();
  await op.goto("/sign-in");
  await op.getByLabel("Email").fill("operator@outcome-ads.test");
  await op.getByLabel("Password").fill("operator-password-123");
  await op.getByRole("button", { name: "Sign in" }).click();
  await expect(op).toHaveURL(/\/operator$/);
  await op.getByRole("link", { name: `E2E Outfitters ${stamp}` }).click();
  await op.getByRole("link", { name: "New campaign" }).click();
  await op.getByLabel("Campaign name").fill("Prospecting — commuters");
  await op.getByLabel("Daily budget (USD)").fill("40");
  await op.getByLabel("Landing page URL").fill(`${site}/backpacks`);
  await op.getByRole("button", { name: "Create campaign" }).click();
  await expect(op).toHaveURL(/\/operator\/campaigns\//);
  const tagged = await op.getByLabel("Tagged landing URL").inputValue();
  const trackingCode = new URL(tagged).searchParams.get("oa_cid")!;
  expect(trackingCode).toMatch(/^[a-z0-9]{10}$/);
  await opContext.close();

  // --- A shopper clicks the ad and buys (simulated through the public APIs) ---------------
  const visitor = `e2evisitor${stamp}`;
  const touch = await request.post("/api/track/touch", {
    headers: { origin: site, "content-type": "text/plain" },
    data: JSON.stringify({
      pk: publicKey,
      vid: visitor,
      type: "touch",
      url: `${site}/backpacks`,
      params: { oa_cid: trackingCode, utm_source: "meta" },
    }),
  });
  expect(touch.status()).toBe(201);
  const order = await request.post("/api/v1/conversions", {
    headers: { authorization: `Bearer ${apiKey}` },
    data: {
      type: "conversion",
      order_id: `E2E-${stamp}`,
      amount_minor: 12_345,
      currency: "USD",
      occurred_at: new Date().toISOString(),
      visitor_id: visitor,
    },
  });
  expect(order.status()).toBe(201);
  expect(await order.json()).toMatchObject({ attributed: true });
  // An organic order from someone who never clicked an ad is not billed.
  await request.post("/api/v1/conversions", {
    headers: { authorization: `Bearer ${apiKey}` },
    data: {
      type: "conversion",
      order_id: `ORG-${stamp}`,
      amount_minor: 50_000,
      currency: "USD",
      occurred_at: new Date().toISOString(),
    },
  });

  // --- The client sees exactly one number move -------------------------------------------
  await page.reload();
  await expect(page.getByTestId("revenue-this-month")).toHaveText("$123.45");
  await expect(page.getByTestId("orders-this-month")).toHaveText("1");
  await expect(page.getByTestId("fee-accrued")).toHaveText("$12.35");
  await expect(page.getByTestId("orders-table")).toContainText(`E2E-${stamp}`);
  await expect(page.getByTestId("orders-table")).toContainText("Prospecting — commuters");
  await expect(page.getByText(/ROAS|impressions|CTR/i)).toHaveCount(0);
});

test("public pages and health endpoints respond", async ({ page, request }) => {
  expect((await request.get("/api/health")).ok()).toBe(true);
  expect((await request.get("/api/ready")).ok()).toBe(true);
  const script = await request.get("/t.js");
  expect(script.headers()["content-type"]).toContain("javascript");
  await page.goto("/faq");
  await expect(page.getByRole("heading", { name: "Frequently asked questions" })).toBeVisible();
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in/);
});
