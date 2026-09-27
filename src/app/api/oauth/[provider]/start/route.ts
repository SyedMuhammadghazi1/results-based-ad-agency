import { NextResponse } from "next/server";
import { env } from "@/env";
import { googleAuthorizeUrl } from "@/lib/connectors/google";
import { metaAuthorizeUrl } from "@/lib/connectors/meta";
import { randomToken, signState } from "@/lib/crypto";
import { googleAppConfigured, metaAppConfigured } from "@/server/connectors";
import { apiRequireRole } from "@/server/guards";
import { handleRouteError, jsonError } from "@/server/http";

export const dynamic = "force-dynamic";

function redirectUri(provider: string) {
  return `${env.APP_URL.replace(/\/$/, "")}/api/oauth/${provider}/callback`;
}

/** Operator-initiated OAuth to connect a client's ad account (Meta / Google Ads). */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const op = await apiRequireRole(req.headers, ["operator", "admin"]);
    const { provider } = await ctx.params;
    const orgId = new URL(req.url).searchParams.get("orgId") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(orgId)) return jsonError(400, "invalid_org");
    const nonce = randomToken(16);
    const state = signState(
      { orgId, nonce, uid: op.id, exp: Date.now() + 10 * 60_000 },
      env.BETTER_AUTH_SECRET,
    );
    let url: string;
    if (provider === "meta" && metaAppConfigured()) {
      url = metaAuthorizeUrl({
        appId: env.META_APP_ID!,
        redirectUri: redirectUri("meta"),
        state,
        apiVersion: env.META_GRAPH_API_VERSION,
      });
    } else if (provider === "google" && googleAppConfigured()) {
      url = googleAuthorizeUrl({
        clientId: env.GOOGLE_ADS_CLIENT_ID!,
        redirectUri: redirectUri("google"),
        state,
      });
    } else {
      return jsonError(404, "provider_not_configured");
    }
    const res = NextResponse.redirect(url);
    res.cookies.set("oa_oauth_nonce", nonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.APP_URL.startsWith("https://"),
      path: "/api/oauth",
      maxAge: 600,
    });
    return res;
  } catch (err) {
    return handleRouteError(err, "oauth.start");
  }
}
