import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";

/** Readiness: the database answers. */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ status: "ready" }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    logger.error({ err }, "readiness check failed");
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
