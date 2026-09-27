import { runMigrations } from "../../src/db/migrate";

/** Migrates the dedicated test database once per run. Refuses anything not named *_test. */
export default async function setup() {
  const url =
    process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/ad_agency_test";
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`Integration tests only run against a *_test database (got "${dbName}")`);
  }
  await runMigrations(url, "./drizzle");
}
