import { defineConfig, devices } from "@playwright/test";

/**
 * E2E smoke tests run against a PRODUCTION build (`next start`) on port 3003, backed by the
 * dedicated test database, which is migrated and re-seeded before the server starts.
 * Run `npm run build` first.
 */
const PORT = 3003;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/ad_agency_test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run db:migrate && npm run db:seed -- --reset && npx next start -p ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      APP_URL: BASE_URL,
      BETTER_AUTH_URL: BASE_URL,
      BETTER_AUTH_SECRET: "e2e-only-secret-0123456789abcdef0123456789",
      DATA_ENCRYPTION_KEY: "ZTJlLWtleS1lMmUta2V5LWUyZS1rZXktMDAwMDAwMDA=",
      DATA_ENCRYPTION_KEY_ID: "e2e",
      CRON_SECRET: "e2e-cron-secret-0123456789",
      AD_CONNECTOR_FALLBACK: "sandbox",
      LOG_LEVEL: "warn",
      SMTP_HOST: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
    },
  },
});
