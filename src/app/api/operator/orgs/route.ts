import { NextResponse } from "next/server";
import { apiRequireRole } from "@/server/guards";
import { handleRouteError } from "@/server/http";
import { listClientOrgs } from "@/server/operator";

export const dynamic = "force-dynamic";

/** Operator-only: every client with internal metrics (spend, ROAS, pacing). */
export async function GET(req: Request) {
  try {
    await apiRequireRole(req.headers, ["operator", "admin"]);
    const rows = await listClientOrgs();
    return NextResponse.json(
      rows.map((r) => ({
        id: r.org.id,
        name: r.org.name,
        status: r.org.status,
        currency: r.org.currency,
        onboardingComplete: r.onboarding.complete,
        revenueMtdMinor: r.revenueMtdMinor,
        spendMtdMinor: r.spendMtdMinor,
        roas: r.roas,
        capMinor: r.capMinor,
        budgetState: r.budgetState,
        activeCampaigns: r.activeCampaigns,
        openAlerts: r.openAlerts,
      })),
    );
  } catch (err) {
    return handleRouteError(err, "api.operator.orgs");
  }
}
