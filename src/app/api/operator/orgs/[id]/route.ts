import { NextResponse } from "next/server";
import { apiRequireRole } from "@/server/guards";
import { handleRouteError, notFound } from "@/server/http";
import { orgPerformance } from "@/server/operator";
import { getOrg } from "@/server/orgs";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await apiRequireRole(req.headers, ["operator", "admin"]);
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const org = await getOrg(id);
    if (!org) throw notFound();
    return NextResponse.json({
      org: { id: org.id, name: org.name, currency: org.currency },
      performance: await orgPerformance(id),
    });
  } catch (err) {
    return handleRouteError(err, "api.operator.org");
  }
}
