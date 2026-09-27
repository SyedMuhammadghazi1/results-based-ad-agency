import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
/** A transaction handle or the root db — service functions accept either. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { __oaPool?: Pool };

function createPool(): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export const pool: Pool = globalForDb.__oaPool ?? createPool();
if (env.NODE_ENV !== "production") globalForDb.__oaPool = pool;

export const db: Database = drizzle(pool, { schema });

export async function closeDb(): Promise<void> {
  await pool.end();
  globalForDb.__oaPool = undefined;
}

export { schema };
