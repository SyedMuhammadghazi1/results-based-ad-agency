import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests NEVER read DATABASE_URL (it may point at a dev/prod database). Integration tests use
 * TEST_DATABASE_URL, defaulting to the local `ad_agency_test` database, and the global setup
 * refuses to run against a database whose name does not end in `_test`.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/ad_agency_test";

const testEnv: Partial<NodeJS.ProcessEnv> = {
  NODE_ENV: "test" as const,
  DATABASE_URL: TEST_DATABASE_URL,
  TEST_DATABASE_URL,
  APP_URL: "http://localhost:3003",
  BETTER_AUTH_URL: "http://localhost:3003",
  BETTER_AUTH_SECRET: "test-only-secret-0123456789abcdef0123456789",
  // 32 zero-ish bytes, base64 — test only.
  DATA_ENCRYPTION_KEY: "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktMDAwMDA=",
  DATA_ENCRYPTION_KEY_ID: "t1",
  CRON_SECRET: "test-cron-secret-0123456789",
  STRIPE_WEBHOOK_SECRET: "whsec_test_platform_secret",
  AD_CONNECTOR_FALLBACK: "sandbox",
  LOG_LEVEL: "silent",
  PAYMENTS_MODE: "stripe",
  SMTP_HOST: "",
  STRIPE_SECRET_KEY: "",
};

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/empty.ts", import.meta.url)),
    },
  },
  test: {
    env: testEnv,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/global-setup.ts"],
          setupFiles: ["tests/integration/setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
