import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Applies the committed SQL migrations in `drizzle/`. Used by `npm run db:migrate`,
 * the test global setup and the `migrate.mjs` bundle shipped in the Docker image.
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder = "./drizzle",
): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
