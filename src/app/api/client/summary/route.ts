import { NextResponse } from "next/server";
import { apiRequireMembership } from "@/server/guards";
import { handleRouteError } from "@/server/http";
import { activeAgreement } from "@/server/orgs";
import { clientSummary } from "@/server/reports";

export const dynamic = "force-dynamic";

/** The signed-in client's revenue summary. The org comes from the session, never the request. */
export async function GET(req: Request) {
  try {
    const m = await apiRequireMembership(req.headers);
    const agreement = await activeAgreement(m.org.id);
    return NextResponse.json(await clientSummary(m.org, new Date(), agreement?.feeRateBps ?? null));
  } catch (err) {
    return handleRouteError(err, "api.client.summary");
  }
}
