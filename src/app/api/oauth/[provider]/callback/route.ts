import { NextResponse } from "next/server";
import { env } from "@/env";
import { exchangeGoogleCode } from "@/lib/connectors/google";
import { exchangeMetaCode } from "@/lib/connectors/meta";
import { safeEqual, verifyState } from "@/lib/crypto";
import { apiRequireRole } from "@/server/guards";
import { handleRouteError, jsonError } from "@/server/http";
import { saveAdPlatformToken } from "@/server/integrations";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";

function redirectUri(provider: string) {
  return `${env.APP_URL.replace(/\/$/, "")}/api/oauth/${provider}/callback`;
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const op = await apiRequireRole(req.headers, ["operator", "admin"]);
    const { provider } = await ctx.params;
    const url = new URL(req.url);
    const state = verifyState<{ orgId: string; nonce: string; uid: string }>(
      url.searchParams.get("state") ?? "",
      env.BETTER_AUTH_SECRET,
    );
    const cookieNonce = req.headers
      .get("cookie")
      ?.split(/;\s*/)
      .find((c) => c.startsWith("oa_oauth_nonce="))
      ?.slice("oa_oauth_nonce=".length);
    if (!state || state.uid !== op.id || !cookieNonce || !safeEqual(cookieNonce, state.nonce)) {
      return jsonError(400, "invalid_state");
    }
    const code = url.searchParams.get("code");
    if (!code)
      return jsonError(400, "missing_code", url.searchParams.get("error_description") ?? undefined);

    if (provider === "meta") {
      const { accessToken } = await exchangeMetaCode({
        appId: env.META_APP_ID!,
        appSecret: env.META_APP_SECRET!,
        redirectUri: redirectUri("meta"),
        code,
        apiVersion: env.META_GRAPH_API_VERSION,
      });
      await saveAdPlatformToken(state.orgId, "meta_ads", accessToken, op);
    } else if (provider === "google") {
      const { refreshToken } = await exchangeGoogleCode({
        clientId: env.GOOGLE_ADS_CLIENT_ID!,
        clientSecret: env.GOOGLE_ADS_CLIENT_SECRET!,
        redirectUri: redirectUri("google"),
        code,
      });
      await saveAdPlatformToken(state.orgId, "google_ads", refreshToken, op);
    } else {
      return jsonError(404, "unknown_provider");
    }
    logger.info({ provider, orgId: state.orgId }, "ad platform connected");
    const res = NextResponse.redirect(
      new URL(`/operator/orgs/${state.orgId}?connected=${provider}`, env.APP_URL),
    );
    res.cookies.delete("oa_oauth_nonce");
    return res;
  } catch (err) {
    return handleRouteError(err, "oauth.callback");
  }
}
