import path from "node:path";
import { runMigrations } from "../src/db/migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const folder = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "drizzle");
runMigrations(url, folder)
  .then(() => {
    console.log(`Migrations applied from ${folder}`);
  })
  .catch((err: unknown) => {
    console.error("Migration failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
