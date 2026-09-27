import type { Campaign, ConnectorKind, Integration, Platform } from "@/db/schema";
import { env } from "@/env";
import { GoogleAdsConnector, refreshGoogleAccessToken } from "@/lib/connectors/google";
import { MetaMarketingConnector } from "@/lib/connectors/meta";
import { ManualConnector, SandboxConnector } from "@/lib/connectors/sandbox";
import { ConnectorError, type AdConnector } from "@/lib/connectors/types";
import { getIntegration } from "./integrations";
import { decrypt } from "./keyring";

/** Resolves which connector drives a campaign. Injected in tests. */
export type ConnectorResolver = (
  campaign: Pick<Campaign, "orgId" | "connector" | "platform">,
) => Promise<AdConnector>;

const sandbox = new SandboxConnector();
const manual = new ManualConnector();

export const metaAppConfigured = () => Boolean(env.META_APP_ID && env.META_APP_SECRET);
export const googleAppConfigured = () =>
  Boolean(
    env.GOOGLE_ADS_CLIENT_ID && env.GOOGLE_ADS_CLIENT_SECRET && env.GOOGLE_ADS_DEVELOPER_TOKEN,
  );

function usable(i: Integration | null): i is Integration & { encryptedSecret: string } {
  return Boolean(i && i.encryptedSecret && i.config.accountId);
}

export const defaultConnectorResolver: ConnectorResolver = async (campaign) => {
  switch (campaign.connector) {
    case "sandbox":
      return sandbox;
    case "manual":
      return manual;
    case "meta": {
      const integration = await getIntegration(campaign.orgId, "meta_ads");
      if (!metaAppConfigured() || !usable(integration)) {
        throw new ConnectorError("Meta is not connected for this client", "meta");
      }
      return new MetaMarketingConnector({
        accessToken: decrypt(integration.encryptedSecret),
        adAccountId: integration.config.accountId!,
        appSecret: env.META_APP_SECRET,
        apiVersion: env.META_GRAPH_API_VERSION,
      });
    }
    case "google": {
      const integration = await getIntegration(campaign.orgId, "google_ads");
      if (!googleAppConfigured() || !usable(integration)) {
        throw new ConnectorError("Google Ads is not connected for this client", "google");
      }
      const refreshToken = decrypt(integration.encryptedSecret);
      let cached: { token: string; at: number } | null = null;
      return new GoogleAdsConnector({
        customerId: integration.config.accountId!,
        loginCustomerId: integration.config.loginCustomerId ?? env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
        developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN!,
        apiVersion: env.GOOGLE_ADS_API_VERSION,
        getAccessToken: async () => {
          if (cached && Date.now() - cached.at < 45 * 60 * 1000) return cached.token;
          const token = await refreshGoogleAccessToken({
            clientId: env.GOOGLE_ADS_CLIENT_ID!,
            clientSecret: env.GOOGLE_ADS_CLIENT_SECRET!,
            refreshToken,
          });
          cached = { token, at: Date.now() };
          return token;
        },
      });
    }
  }
};

/** Connectors an operator can pick for a new campaign on `platform` for this org. */
export async function availableConnectors(
  orgId: string,
  platform: Platform,
): Promise<ConnectorKind[]> {
  const out: ConnectorKind[] = [];
  if (
    platform === "meta" &&
    metaAppConfigured() &&
    usable(await getIntegration(orgId, "meta_ads"))
  ) {
    out.push("meta");
  }
  if (
    platform === "google" &&
    googleAppConfigured() &&
    usable(await getIntegration(orgId, "google_ads"))
  ) {
    out.push("google");
  }
  out.push(env.AD_CONNECTOR_FALLBACK);
  if (env.AD_CONNECTOR_FALLBACK !== "manual") out.push("manual");
  return out;
}
