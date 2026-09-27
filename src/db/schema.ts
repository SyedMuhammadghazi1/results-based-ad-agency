import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Conventions
 * - Money is ALWAYS an integer amount of minor units (cents) plus an ISO-4217 currency code.
 *   `bigint` columns use mode "number"; values stay far below 2^53.
 * - Rates are basis points (1000 bps = 10%).
 * - Every timestamp is `timestamptz`; periods are UTC.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const money = (name: string) => bigint(name, { mode: "number" });

// ---------------------------------------------------------------------------
// Better Auth core tables
// ---------------------------------------------------------------------------

export const USER_ROLES = ["client", "operator", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").$type<UserRole>().notNull().default("client"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ---------------------------------------------------------------------------
// Client organizations
// ---------------------------------------------------------------------------

export const ORG_STATUSES = ["onboarding", "active", "paused", "churned"] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status: text("status").$type<OrgStatus>().notNull().default("onboarding"),
    currency: text("currency").notNull().default("USD"),
    /** Public tracking key embedded in t.js (`oa_pk_…`). Not a secret. */
    publicKey: text("public_key").notNull().unique(),
    /** Exact origins (scheme://host[:port]) allowed to post touches. */
    allowedOrigins: text("allowed_origins").array().notNull().default(sql`'{}'::text[]`),
    /** SHA-256 of the server-to-server API key. The key itself is shown once. */
    apiKeyHash: text("api_key_hash"),
    apiKeyPrefix: text("api_key_prefix"),
    apiKeyCreatedAt: ts("api_key_created_at"),
    /** Commercial offer shown on the agreement step (operators may adjust before acceptance). */
    offeredFeeRateBps: integer("offered_fee_rate_bps").notNull().default(1000),
    offeredAttributionWindowDays: integer("offered_attribution_window_days").notNull().default(7),
    stripeCustomerId: text("stripe_customer_id").unique(),
    paymentMethodReadyAt: ts("payment_method_ready_at"),
    trackingLastSeenAt: ts("tracking_last_seen_at"),
    /** Set while campaigns are held because of unpaid invoices. */
    dunningPausedAt: ts("dunning_paused_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("org_currency_iso", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("org_fee_rate_range", sql`${t.offeredFeeRateBps} between 1 and 10000`),
  ],
);

export const ORG_MEMBER_ROLES = ["owner", "member"] as const;
export type OrgMemberRole = (typeof ORG_MEMBER_ROLES)[number];

export const orgMembers = pgTable(
  "org_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<OrgMemberRole>().notNull().default("member"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    // A user belongs to exactly one client organization.
    uniqueIndex("org_members_user_unique").on(t.userId),
    index("org_members_org_idx").on(t.orgId),
  ],
);

export const orgInvitations = pgTable(
  "org_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedByUserId: text("invited_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("org_invitations_org_idx").on(t.orgId)],
);

/** Onboarding intake questionnaire (one per org). */
export const orgIntakes = pgTable(
  "org_intakes",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    website: text("website").notNull(),
    productOffer: text("product_offer").notNull(),
    averageOrderValueMinor: money("average_order_value_minor").notNull(),
    grossMarginBps: integer("gross_margin_bps").notNull(),
    targetGeos: text("target_geos").array().notNull(),
    monthlySpendCapMinor: money("monthly_spend_cap_minor").notNull(),
    creativeAssetLinks: text("creative_asset_links").array().notNull().default(sql`'{}'::text[]`),
    submittedByUserId: text("submitted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("intake_aov_positive", sql`${t.averageOrderValueMinor} > 0`),
    check("intake_cap_positive", sql`${t.monthlySpendCapMinor} > 0`),
    check("intake_margin_range", sql`${t.grossMarginBps} between 0 and 10000`),
  ],
);

/** Accepted performance agreements. The newest non-superseded row is in force. */
export const agreements = pgTable(
  "agreements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    feeRateBps: integer("fee_rate_bps").notNull(),
    attributionWindowDays: integer("attribution_window_days").notNull(),
    billingTerms: text("billing_terms").notNull(),
    renderedTerms: text("rendered_terms").notNull(),
    termsHash: text("terms_hash").notNull(),
    acceptedByUserId: text("accepted_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    acceptedAt: ts("accepted_at").notNull().defaultNow(),
    acceptedIp: text("accepted_ip"),
    acceptedUserAgent: text("accepted_user_agent"),
    supersededAt: ts("superseded_at"),
  },
  (t) => [
    index("agreements_org_idx").on(t.orgId, t.acceptedAt),
    // Only one agreement in force per org.
    uniqueIndex("agreements_one_active_per_org")
      .on(t.orgId)
      .where(sql`${t.supersededAt} is null`),
    check("agreement_fee_rate_range", sql`${t.feeRateBps} between 1 and 10000`),
    check("agreement_window_range", sql`${t.attributionWindowDays} between 1 and 90`),
  ],
);

export const INTEGRATION_KINDS = ["shopify", "stripe", "meta_ads", "google_ads"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** Per-org third-party integrations. Secrets are AES-256-GCM encrypted (see lib/crypto). */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IntegrationKind>().notNull(),
    status: text("status").$type<"pending" | "connected" | "error">().notNull().default("pending"),
    encryptedSecret: text("encrypted_secret"),
    config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
    lastEventAt: ts("last_event_at"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("integrations_org_kind_unique").on(t.orgId, t.kind)],
);

// ---------------------------------------------------------------------------
// Campaigns & spend (spend is internal only — never shown to clients)
// ---------------------------------------------------------------------------

export const PLATFORMS = ["meta", "google", "tiktok"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const OBJECTIVES = ["sales", "leads", "traffic", "awareness"] as const;
export type Objective = (typeof OBJECTIVES)[number];
export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const CONNECTOR_KINDS = ["sandbox", "meta", "google", "manual"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export const PAUSE_REASONS = ["manual", "budget_cap", "dunning"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export type Creative = { name: string; url: string; format: "image" | "video" | "carousel" | "text" };

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").$type<Platform>().notNull(),
    objective: text("objective").$type<Objective>().notNull(),
    connector: text("connector").$type<ConnectorKind>().notNull(),
    status: text("status").$type<CampaignStatus>().notNull().default("draft"),
    pausedReason: text("paused_reason").$type<PauseReason>(),
    pausedAt: ts("paused_at"),
    dailyBudgetMinor: money("daily_budget_minor").notNull(),
    currency: text("currency").notNull(),
    landingUrl: text("landing_url").notNull(),
    /** Value of the `oa_cid` URL parameter carried by every ad click. */
    trackingCode: text("tracking_code").notNull().unique(),
    externalId: text("external_id"),
    creatives: jsonb("creatives").$type<Creative[]>().notNull().default([]),
    targetingNotes: text("targeting_notes").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("campaigns_org_idx").on(t.orgId),
    check("campaign_budget_positive", sql`${t.dailyBudgetMinor} > 0`),
  ],
);

export const adSpendDaily = pgTable(
  "ad_spend_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    spendMinor: money("spend_minor").notNull(),
    currency: text("currency").notNull(),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_spend_campaign_date_unique").on(t.campaignId, t.date),
    index("ad_spend_org_date_idx").on(t.orgId, t.date),
  ],
);

// ---------------------------------------------------------------------------
// Tracking, conversions & attribution
// ---------------------------------------------------------------------------

export const touches = pgTable(
  "touches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    visitorId: text("visitor_id").notNull(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    landingHost: text("landing_host"),
    landingPath: text("landing_path"),
    referrerHost: text("referrer_host"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),
    gclid: text("gclid"),
    fbclid: text("fbclid"),
    ttclid: text("ttclid"),
    oaCid: text("oa_cid"),
  },
  (t) => [index("touches_org_visitor_time_idx").on(t.orgId, t.visitorId, t.occurredAt)],
);

export const CONVERSION_SOURCES = ["api", "shopify", "stripe"] as const;
export type ConversionSource = (typeof CONVERSION_SOURCES)[number];

export const conversions = pgTable(
  "conversions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    source: text("source").$type<ConversionSource>().notNull(),
    externalOrderId: text("external_order_id").notNull(),
    visitorId: text("visitor_id"),
    occurredAt: ts("occurred_at").notNull(),
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull(),
    /** Sum of refunds recorded against this conversion (positive number). */
    refundedMinor: money("refunded_minor").notNull().default(0),
    attributed: boolean("attributed").notNull(),
    attributionReason: text("attribution_reason").notNull(),
    attributedTouchId: uuid("attributed_touch_id").references(() => touches.id, {
      onDelete: "set null",
    }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    platform: text("platform").$type<Platform>(),
    agreementId: uuid("agreement_id").references(() => agreements.id, { onDelete: "restrict" }),
    /** Fee rate snapshotted from the agreement in force when the conversion was attributed. */
    feeRateBps: integer("fee_rate_bps"),
    billingPeriodId: uuid("billing_period_id").references(() => billingPeriods.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversions_dedupe_unique").on(t.orgId, t.source, t.externalOrderId),
    index("conversions_org_time_idx").on(t.orgId, t.occurredAt),
    index("conversions_unbilled_idx")
      .on(t.orgId)
      .where(sql`${t.attributed} and ${t.billingPeriodId} is null`),
    check("conversion_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "conversion_refund_bounds",
      sql`${t.refundedMinor} >= 0 and ${t.refundedMinor} <= ${t.amountMinor}`,
    ),
  ],
);

/** Refunds recorded as negative adjustments linked to the original conversion. */
export const conversionAdjustments = pgTable(
  "conversion_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversionId: uuid("conversion_id")
      .notNull()
      .references(() => conversions.id, { onDelete: "cascade" }),
    source: text("source").$type<ConversionSource>().notNull(),
    externalRefundId: text("external_refund_id").notNull(),
    /** Always negative: the revenue removed by the refund. */
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    billingPeriodId: uuid("billing_period_id").references(() => billingPeriods.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("adjustments_dedupe_unique").on(t.orgId, t.source, t.externalRefundId),
    index("adjustments_org_time_idx").on(t.orgId, t.occurredAt),
    index("adjustments_conversion_idx").on(t.conversionId),
    check("adjustment_amount_negative", sql`${t.amountMinor} < 0`),
  ],
);

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const BILLING_STATUSES = [
  "pending_invoice",
  "no_charge",
  "open",
  "paid",
  "payment_failed",
  "void",
  "uncollectible",
] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export type FeeLine = { feeRateBps: number; netRevenueMinor: number; feeMinor: number };

/** One row per org per calendar month (UTC). The unique constraint makes billing idempotent. */
export const billingPeriods = pgTable(
  "billing_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    currency: text("currency").notNull(),
    grossRevenueMinor: money("gross_revenue_minor").notNull(),
    netRevenueMinor: money("net_revenue_minor").notNull(),
    feeLines: jsonb("fee_lines").$type<FeeLine[]>().notNull().default([]),
    grossFeeMinor: money("gross_fee_minor").notNull(),
    creditGeneratedMinor: money("credit_generated_minor").notNull(),
    creditCarriedInMinor: money("credit_carried_in_minor").notNull(),
    creditAppliedMinor: money("credit_applied_minor").notNull(),
    creditCarriedOutMinor: money("credit_carried_out_minor").notNull(),
    amountDueMinor: money("amount_due_minor").notNull(),
    status: text("status").$type<BillingStatus>().notNull(),
    stripeInvoiceId: text("stripe_invoice_id").unique(),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    issuedAt: ts("issued_at"),
    paidAt: ts("paid_at"),
    lastPaymentError: text("last_payment_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_periods_org_period_unique").on(t.orgId, t.periodStart),
    check("billing_amounts_non_negative", sql`${t.amountDueMinor} >= 0 and ${t.grossFeeMinor} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Operations: alerts, audit, webhooks, rate limits, jobs, leads
// ---------------------------------------------------------------------------

export const ALERT_KINDS = [
  "budget_cap_reached",
  "budget_cap_near",
  "payment_failed",
  "dunning_paused",
  "manual_action_required",
  "connector_error",
  "new_application",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AlertKind>().notNull(),
    severity: text("severity").$type<"info" | "warning" | "critical">().notNull(),
    message: text("message").notNull(),
    dedupeKey: text("dedupe_key").unique(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (t) => [index("alerts_open_idx").on(t.createdAt).where(sql`${t.resolvedAt} is null`)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorRole: text("actor_role"),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_created_idx").on(t.createdAt),
    index("audit_log_org_idx").on(t.orgId, t.createdAt),
  ],
);

/** Processed webhook deliveries, for idempotency. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    processedAt: ts("processed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

/** Fixed-window rate limiter state shared by all app instances. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull(),
});

export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    job: text("job").notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    status: text("status").$type<"running" | "succeeded" | "failed">().notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    error: text("error"),
  },
  (t) => [index("job_runs_job_idx").on(t.job, t.startedAt)],
);

/** Idempotency ledger for outbound notification emails (e.g. weekly reports). */
export const emailSends = pgTable(
  "email_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    periodKey: text("period_key").notNull(),
    recipients: integer("recipients").notNull(),
    sentAt: ts("sent_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("email_sends_unique").on(t.orgId, t.kind, t.periodKey)],
);

/** Public "apply" form submissions (pre-signup leads). */
export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  company: text("company").notNull(),
  website: text("website").notNull(),
  monthlyRevenueBand: text("monthly_revenue_band").notNull(),
  monthlyAdSpendBand: text("monthly_ad_spend_band").notNull(),
  message: text("message").notNull().default(""),
  status: text("status").$type<"new" | "contacted" | "accepted" | "declined">().notNull().default("new"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Conversion = typeof conversions.$inferSelect;
export type Agreement = typeof agreements.$inferSelect;
export type BillingPeriod = typeof billingPeriods.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type Touch = typeof touches.$inferSelect;
export type User = typeof user.$inferSelect;
