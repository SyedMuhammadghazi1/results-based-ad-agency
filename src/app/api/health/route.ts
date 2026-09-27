import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: the process is up. Never touches the database. */
export function GET() {
  return NextResponse.json(
    { status: "ok", time: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
}
