import { z } from "zod";

/**
 * Centralised, validated environment configuration.
 *
 * Validation fails fast at runtime. `SKIP_ENV_VALIDATION=1` relaxes it for `next build` and
 * CI/dev tooling that never talks to real services; in that mode missing values are `undefined`
 * (never placeholders) and any code path that needs them fails loudly when it runs. A running
 * production server ignores the flag — see `envValidationSkipped`.
 */

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const base64Key32 = z.string().refine((v) => {
  try {
    return Buffer.from(v, "base64").length === 32;
  } catch {
    return false;
  }
}, "must be 32 random bytes, base64 encoded (openssl rand -base64 32)");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  APP_URL: z.url().default("http://localhost:3000"),
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default("Outcome Ads"),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: bool,

  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
  BETTER_AUTH_URL: optionalString,

  DATA_ENCRYPTION_KEY: base64Key32,
  DATA_ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[a-z0-9]{1,16}$/i)
    .default("k1"),
  /** Comma separated `keyId:base64Key` pairs that can still decrypt (rotation). */
  DATA_ENCRYPTION_PREVIOUS_KEYS: optionalString,

  CRON_SECRET: z.string().min(16, "must be at least 16 characters"),

  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  /** `test-bypass` skips Stripe for the payment-method step. Ignored when NODE_ENV=production. */
  PAYMENTS_MODE: z.enum(["stripe", "test-bypass"]).default("stripe"),

  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_SECURE: bool,
  EMAIL_FROM: z.string().default("Outcome Ads <no-reply@localhost>"),
  OPERATOR_ALERT_EMAIL: optionalString,

  DEFAULT_FEE_RATE_BPS: z.coerce.number().int().min(1).max(10_000).default(1000),
  DEFAULT_ATTRIBUTION_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  DUNNING_GRACE_DAYS: z.coerce.number().int().min(1).max(120).default(14),

  /** Connector used when a platform's real API credentials are not configured. */
  AD_CONNECTOR_FALLBACK: z.enum(["sandbox", "manual"]).default("sandbox"),

  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_GRAPH_API_VERSION: z.string().default("v23.0"),

  GOOGLE_ADS_CLIENT_ID: optionalString,
  GOOGLE_ADS_CLIENT_SECRET: optionalString,
  GOOGLE_ADS_DEVELOPER_TOKEN: optionalString,
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: optionalString,
  GOOGLE_ADS_API_VERSION: z.string().default("v21"),
});

export type Env = z.infer<typeof schema>;

/**
 * Whether `SKIP_ENV_VALIDATION` applies. With `NODE_ENV=production` it only does during
 * `next build` (Next sets `NEXT_PHASE=phase-production-build`): a production server that inherited
 * the flag (e.g. from a build image or a copied env file) still validates and fails fast.
 */
export function envValidationSkipped(source: NodeJS.ProcessEnv = process.env): boolean {
  const requested = source.SKIP_ENV_VALIDATION === "1" || source.SKIP_ENV_VALIDATION === "true";
  if (!requested) return false;
  if (source.NODE_ENV !== "production") return true;
  return source.NEXT_PHASE === "phase-production-build";
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (parsed.success) return parsed.data;
  if (envValidationSkipped(source)) {
    // Lenient mode: keep every value that validates on its own (with defaults applied) and
    // leave the rest undefined.
    const lenient: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.shape)) {
      const result = (field as z.ZodType).safeParse(source[key]);
      lenient[key] = result.success ? result.data : undefined;
    }
    return lenient as Env;
  }
  throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === "production";

/** Payment bypass is never honoured in production builds/runtime. */
export const paymentsBypassed = !isProduction && env.PAYMENTS_MODE === "test-bypass";

export const appName = env.NEXT_PUBLIC_APP_NAME;
