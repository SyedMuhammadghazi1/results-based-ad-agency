import { NextResponse } from "next/server";
import { apiRequireMembership } from "@/server/guards";
import { handleRouteError, notFound } from "@/server/http";
import { getBillingPeriodForOrg } from "@/server/reports";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const m = await apiRequireMembership(req.headers);
    const { id } = await ctx.params;
    const invoice = await getBillingPeriodForOrg(m.org.id, id);
    if (!invoice) throw notFound();
    return NextResponse.json(invoice);
  } catch (err) {
    return handleRouteError(err, "api.client.invoice");
  }
}
