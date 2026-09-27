import { NextResponse } from "next/server";
import { apiRequireMembership } from "@/server/guards";
import { handleRouteError } from "@/server/http";
import { attributedOrders } from "@/server/reports";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const m = await apiRequireMembership(req.headers);
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
    const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
    return NextResponse.json(await attributedOrders(m.org.id, { limit, offset }));
  } catch (err) {
    return handleRouteError(err, "api.client.orders");
  }
}
