import { sql } from "drizzle-orm";
import { afterAll, beforeEach } from "vitest";
import { closeDb, db } from "@/db";
import { outbox } from "@/server/mailer";

let tables: string | null = null;

beforeEach(async () => {
  if (!tables) {
    const rows = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    tables = rows.rows.map((r) => `"${r.tablename}"`).join(", ");
  }
  await db.execute(sql.raw(`truncate ${tables} restart identity cascade`));
  outbox.length = 0;
});

afterAll(async () => {
  await closeDb();
});
