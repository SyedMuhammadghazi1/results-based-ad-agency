/**
 * Seeds an admin, an operator and realistic demo data:
 *  - "Acme Outdoor Co." — fully onboarded client with campaigns, tracked touches, attributed and
 *    organic orders, refunds, 35 days of (sandbox) spend and last month's billing statement;
 *  - "Bluebird Coffee" — a client midway through onboarding.
 *
 * Usage: npm run db:seed            (skips if the admin already exists)
 *        npm run db:seed -- --reset (TRUNCATES all data first; dev/test databases only)
 */
import { eq, sql } from "drizzle-orm";
import { closeDb, db } from "../src/db";
import {
  agreements,
  billingPeriods,
  campaigns,
  organizations,
  user,
  type UserRole,
} from "../src/db/schema";
import { addDays, previousPeriod, startOfUtcDay } from "../src/lib/dates";
import { formatMinor } from "../src/lib/money";
import { raiseAlert } from "../src/server/alerts";
import { auth } from "../src/server/auth";
import { billOrgForPeriod } from "../src/server/billing";
import {
  createCampaign,
  setCampaignStatus,
  SYSTEM,
  syncCampaignSpend,
} from "../src/server/campaigns";
import { recordConversion, recordRefund } from "../src/server/conversions";
import {
  acceptAgreement,
  agreementTermsFor,
  createOrganization,
  rotateApiKey,
  saveIntake,
} from "../src/server/orgs";
import { ingestTouch } from "../src/server/tracking";

export const DEMO = {
  admin: { email: "admin@outcome-ads.test", password: "admin-password-123", name: "Ada Admin" },
  operator: {
    email: "operator@outcome-ads.test",
    password: "operator-password-123",
    name: "Oscar Operator",
  },
  client: {
    email: "owner@acme-outdoor.test",
    password: "client-password-123",
    name: "Carla Client",
  },
  onboarding: {
    email: "owner@bluebird-coffee.test",
    password: "client-password-123",
    name: "Ben Bluebird",
  },
};

// Deterministic PRNG so the demo looks the same every time.
let seedState = 42;
function rand() {
  seedState = (seedState * 1_664_525 + 1_013_904_223) % 2 ** 32;
  return seedState / 2 ** 32;
}
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

async function createUser(u: { email: string; password: string; name: string }, role: UserRole) {
  await auth.api.signUpEmail({ body: { email: u.email, password: u.password, name: u.name } });
  const [row] = await db
    .update(user)
    .set({ role, emailVerified: true })
    .where(eq(user.email, u.email))
    .returning();
  return { id: row!.id, email: row!.email, name: row!.name, role };
}

async function reset() {
  const dbName =
    (await db.execute<{ db: string }>(sql`select current_database() as db`)).rows[0]?.db ?? "";
  if (!/_(dev|test)$/.test(dbName) && process.env.SEED_FORCE_RESET !== "1") {
    throw new Error(
      `Refusing to reset database "${dbName}" (only *_dev / *_test). Set SEED_FORCE_RESET=1 to override.`,
    );
  }
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const list = tables.rows.map((t) => `"${t.tablename}"`).join(", ");
  if (list) await db.execute(sql.raw(`truncate ${list} restart identity cascade`));
}

async function main() {
  // Demo users have well-known passwords; never create them in production by accident.
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PRODUCTION_SEED !== "1") {
    throw new Error("Refusing to seed demo data with NODE_ENV=production.");
  }
  if (process.argv.includes("--reset")) await reset();
  const existing = await db.select().from(user).where(eq(user.email, DEMO.admin.email)).limit(1);
  if (existing.length > 0) {
    console.log("Seed data already present (use --reset to recreate).");
    printCredentials();
    return;
  }

  const now = new Date();
  await createUser(DEMO.admin, "admin");
  const operator = await createUser(DEMO.operator, "operator");
  const owner = await createUser(DEMO.client, "client");
  const bluebirdOwner = await createUser(DEMO.onboarding, "client");

  // --- Acme Outdoor: fully onboarded --------------------------------------------------
  let acme = await createOrganization(owner, { name: "Acme Outdoor Co.", currency: "USD" });
  await saveIntake(acme, owner, {
    website: "https://shop.acme-outdoor.test",
    productOffer:
      "Lightweight hiking and camping gear. Hero product: the 900g Ridgeline tent. Summer sale 15% off.",
    averageOrderValue: "142.00",
    grossMarginPct: 58,
    targetGeos: "US, CA",
    monthlySpendCap: "15000",
    creativeAssetLinks:
      "https://drive.example.com/acme/brand-kit\nhttps://drive.example.com/acme/ugc-videos",
  });
  acme = (await db.select().from(organizations).where(eq(organizations.id, acme.id)))[0]!;
  const agreement = await acceptAgreement({
    org: acme,
    user: owner,
    shownHash: agreementTermsFor(acme).hash,
    ip: "203.0.113.10",
    userAgent: "seed",
  });
  await db
    .update(agreements)
    .set({ acceptedAt: addDays(now, -75) })
    .where(eq(agreements.id, agreement.id));
  await rotateApiKey(acme, owner);
  await db
    .update(organizations)
    .set({ paymentMethodReadyAt: addDays(now, -74), createdAt: addDays(now, -76) })
    .where(eq(organizations.id, acme.id));

  const meta = await createCampaign(operator, acme.id, {
    name: "Prospecting — Ridgeline tent",
    platform: "meta",
    objective: "sales",
    connector: "sandbox",
    dailyBudget: "220",
    landingUrl: "https://shop.acme-outdoor.test/products/ridgeline",
    targetingNotes: "Broad US/CA 25-54, Advantage+ audience, exclude purchasers 30d.",
    creatives:
      "UGC unboxing | https://drive.example.com/acme/ugc-1.mp4 | video\nTent in 60s | https://drive.example.com/acme/setup.mp4 | video",
  });
  const google = await createCampaign(operator, acme.id, {
    name: "Search — brand + category",
    platform: "google",
    objective: "sales",
    connector: "sandbox",
    dailyBudget: "150",
    landingUrl: "https://shop.acme-outdoor.test/",
    targetingNotes: "Exact/phrase on brand + 'ultralight tent'. tROAS after 30 conversions.",
    creatives: "",
  });
  const tiktok = await createCampaign(operator, acme.id, {
    name: "TikTok Spark — trail stories",
    platform: "tiktok",
    objective: "traffic",
    connector: "manual",
    dailyBudget: "60",
    landingUrl: "https://shop.acme-outdoor.test/collections/summer",
    targetingNotes: "Spark ads from creator partners.",
    creatives: "",
  });
  for (const c of [meta, google])
    await setCampaignStatus(SYSTEM, c, "active", { skipLaunchChecks: true });
  await db
    .update(campaigns)
    .set({ status: "paused", pausedReason: "manual", pausedAt: addDays(now, -3) })
    .where(eq(campaigns.id, tiktok.id));

  // Spend for the last 35 days (internal only).
  const today = startOfUtcDay(now);
  for (const c of [meta, google]) {
    const fresh = (await db.select().from(campaigns).where(eq(campaigns.id, c.id)))[0]!;
    await syncCampaignSpend(fresh, addDays(today, -34), today);
  }

  // Touches + orders over the last 45 days. Real services → real attribution.
  const origin = "https://shop.acme-outdoor.test";
  const codes = [meta.trackingCode, meta.trackingCode, google.trackingCode];
  let orderNo = 1000;
  const conversionsForRefund: string[] = [];
  let attributedCount = 0;
  for (let day = 45; day >= 0; day--) {
    const visitors = 6 + Math.floor(rand() * 6);
    for (let v = 0; v < visitors; v++) {
      const vid = `seed${day}v${v}x${Math.floor(rand() * 1e9).toString(36)}`.padEnd(20, "0");
      const touchAt = new Date(
        addDays(today, -day).getTime() + Math.floor(rand() * 20) * 3_600_000,
      );
      if (touchAt > now) continue;
      const kind = rand();
      const params =
        kind < 0.65
          ? { oa_cid: pick(codes), utm_source: "meta", utm_medium: "paid_social" }
          : kind < 0.8
            ? { gclid: `Cj0KCQ${Math.floor(rand() * 1e9)}` }
            : { utm_source: "newsletter", utm_medium: "email" };
      await ingestTouch(
        {
          pk: acme.publicKey,
          vid,
          type: "touch",
          url: `${origin}/products/ridgeline`,
          ref: "https://www.facebook.com/",
          params,
        },
        origin,
        touchAt,
      );
      if (rand() < 0.45) {
        const orderAt = new Date(touchAt.getTime() + Math.floor(rand() * 72) * 3_600_000);
        if (orderAt > now) continue;
        const amount = 6_000 + Math.floor(rand() * 22_000);
        const res = await recordConversion(acme, "api", {
          kind: "conversion",
          externalOrderId: `#${orderNo++}`,
          occurredAt: orderAt,
          amountMinor: amount,
          currency: "USD",
          visitorId: vid,
        });
        if (res.status === "recorded" && res.attributed) {
          attributedCount++;
          if (rand() < 0.06) conversionsForRefund.push(`#${orderNo - 1}`);
        }
      }
    }
    // Some orders with no tracked visitor (organic/direct) — never attributed.
    if (addDays(today, -day) <= now) {
      await recordConversion(acme, "api", {
        kind: "conversion",
        externalOrderId: `#${orderNo++}`,
        occurredAt: new Date(addDays(today, -day).getTime() + 3_600_000),
        amountMinor: 9_900,
        currency: "USD",
        visitorId: null,
      });
    }
  }
  for (const [i, id] of conversionsForRefund.entries()) {
    await recordRefund(acme, "api", {
      kind: "refund",
      externalOrderId: id,
      externalRefundId: `rf_${id}`,
      occurredAt: new Date(now.getTime() - (i + 1) * 3_600_000),
      amountMinor: i % 2 === 0 ? 5_000 : 1_000_000,
      currency: "USD",
    });
  }

  // Last month's statement (no Stripe in the seed): mark it paid for the demo.
  const period = previousPeriod(now);
  const bill = await billOrgForPeriod(acme, period, null, now);
  await db
    .update(billingPeriods)
    .set({ status: "paid", issuedAt: period.end, paidAt: addDays(period.end, 1) })
    .where(
      sql`${billingPeriods.id} = ${bill.billingPeriodId} and ${billingPeriods.status} = 'pending_invoice'`,
    );

  await raiseAlert({
    orgId: acme.id,
    kind: "manual_action_required",
    severity: "warning",
    message: `Pause "TikTok Spark — trail stories" by hand in tiktok (seeded example)`,
    dedupeKey: "seed:tiktok-manual",
  });

  // --- Bluebird Coffee: mid-onboarding ------------------------------------------------
  const bluebird = await createOrganization(bluebirdOwner, {
    name: "Bluebird Coffee",
    currency: "USD",
  });
  await saveIntake(bluebird, bluebirdOwner, {
    website: "https://bluebird-coffee.test",
    productOffer: "Specialty coffee subscriptions, first bag 50% off.",
    averageOrderValue: "38",
    grossMarginPct: 64,
    targetGeos: "US",
    monthlySpendCap: "4000",
    creativeAssetLinks: "",
  });

  console.log(
    `Seeded ${attributedCount} attributed orders for Acme (last statement: ${bill.status}).`,
  );
  const summary = await db.execute<{ total: string }>(
    sql`select coalesce(sum(amount_minor - refunded_minor),0)::text as total from conversions where attributed`,
  );
  console.log(
    `Total net attributed revenue: ${formatMinor(Number(summary.rows[0]?.total ?? 0), "USD")}`,
  );
  printCredentials();
}

function printCredentials() {
  console.log("\nDemo credentials (all local-only):");
  console.log(`  admin     ${DEMO.admin.email} / ${DEMO.admin.password}`);
  console.log(`  operator  ${DEMO.operator.email} / ${DEMO.operator.password}`);
  console.log(
    `  client    ${DEMO.client.email} / ${DEMO.client.password}   (Acme Outdoor Co., onboarded)`,
  );
  console.log(
    `  client    ${DEMO.onboarding.email} / ${DEMO.onboarding.password}   (Bluebird Coffee, mid-onboarding)`,
  );
}

main()
  .then(() => closeDb())
  .catch(async (err: unknown) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
