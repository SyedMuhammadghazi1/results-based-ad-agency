import { microsToMinor, minorToMicros } from "../money";
import type { Objective } from "@/db/schema";
import {
  ConnectorError,
  type ActionResult,
  type AdConnector,
  type CreateCampaignInput,
  type DailySpend,
  type ExternalCampaignRef,
  type FetchLike,
} from "./types";

/**
 * Google Ads API connector (REST interface over fetch).
 *
 * Requires: an OAuth refresh token for a Google user with access to the client's Google Ads
 * account, the agency's developer token (Basic or Standard access — test-account-only tokens
 * cannot touch real accounts) and, when access goes through a manager (MCC) account,
 * `login-customer-id`. See docs/DEPLOYMENT.md.
 *
 * Spend comes from `googleAds:searchStream` (metrics.cost_micros per segments.date); campaigns
 * and budgets are changed with `campaigns:mutate` / `campaignBudgets:mutate`.
 */

export type GoogleAdsConfig = {
  customerId: string;
  developerToken: string;
  loginCustomerId?: string;
  apiVersion: string;
  getAccessToken: () => Promise<string>;
  fetch?: FetchLike;
};

/** Bidding strategy per objective (campaigns are created PAUSED for operator review). */
export const GOOGLE_BIDDING: Record<Objective, Record<string, object>> = {
  sales: { maximizeConversionValue: {} },
  leads: { maximizeConversions: {} },
  traffic: { targetSpend: {} },
  awareness: { targetSpend: {} },
};

type GoogleError = { error?: { message?: string; status?: string; code?: number } };

function digits(id: string): string {
  const d = id.replace(/-/g, "");
  if (!/^\d+$/.test(d)) throw new ConnectorError(`Invalid Google Ads id: ${id}`, "google");
  return d;
}

export class GoogleAdsConnector implements AdConnector {
  readonly kind = "google" as const;
  private readonly fetch: FetchLike;
  private readonly customerId: string;

  constructor(private readonly cfg: GoogleAdsConfig) {
    this.fetch = cfg.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.customerId = digits(cfg.customerId);
  }

  private url(path: string): string {
    return `https://googleads.googleapis.com/${this.cfg.apiVersion}/customers/${this.customerId}/${path}`;
  }

  async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      authorization: `Bearer ${await this.cfg.getAccessToken()}`,
      "developer-token": this.cfg.developerToken,
      "content-type": "application/json",
    };
    if (this.cfg.loginCustomerId) h["login-customer-id"] = digits(this.cfg.loginCustomerId);
    return h;
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetch(this.url(path), {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(body),
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ConnectorError(`Google Ads API returned non-JSON (HTTP ${res.status})`, "google", res.status);
    }
    const err = Array.isArray(json)
      ? (json[0] as GoogleError | undefined)?.error
      : (json as GoogleError).error;
    if (!res.ok || err) {
      throw new ConnectorError(
        `Google Ads API error: ${err?.message ?? `HTTP ${res.status}`}`,
        "google",
        res.status,
        err?.status,
      );
    }
    return json;
  }

  campaignResource(externalId: string): string {
    return `customers/${this.customerId}/campaigns/${digits(externalId)}`;
  }

  async createCampaign(input: CreateCampaignInput) {
    const budget = (await this.call("campaignBudgets:mutate", {
      operations: [
        {
          create: {
            name: `${input.name} budget ${input.trackingCode}`,
            amountMicros: String(minorToMicros(input.dailyBudgetMinor, input.currency)),
            deliveryMethod: "STANDARD",
            explicitlyShared: false,
          },
        },
      ],
    })) as { results?: Array<{ resourceName?: string }> };
    const budgetResource = budget.results?.[0]?.resourceName;
    if (!budgetResource) throw new ConnectorError("Google Ads did not return a budget", "google");

    const campaign = (await this.call("campaigns:mutate", {
      operations: [
        {
          create: {
            name: input.name,
            status: "PAUSED",
            advertisingChannelType: "SEARCH",
            campaignBudget: budgetResource,
            ...GOOGLE_BIDDING[input.objective],
            networkSettings: {
              targetGoogleSearch: true,
              targetSearchNetwork: false,
              targetContentNetwork: false,
            },
            containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
            trackingUrlTemplate: `{lpurl}?oa_cid=${input.trackingCode}&utm_source=google&utm_medium=cpc&utm_campaign={campaignid}`,
          },
        },
      ],
    })) as { results?: Array<{ resourceName?: string }> };
    const resource = campaign.results?.[0]?.resourceName;
    const id = resource?.split("/").pop();
    if (!id) throw new ConnectorError("Google Ads did not return a campaign", "google");
    return { externalId: id };
  }

  async setStatus(ref: ExternalCampaignRef, status: "active" | "paused"): Promise<ActionResult> {
    await this.call("campaigns:mutate", {
      operations: [
        {
          update: {
            resourceName: this.campaignResource(ref.externalId),
            status: status === "active" ? "ENABLED" : "PAUSED",
          },
          updateMask: "status",
        },
      ],
    });
    return { manual: false };
  }

  async setDailyBudget(ref: ExternalCampaignRef, dailyBudgetMinor: number): Promise<ActionResult> {
    const rows = await this.search(
      `SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${digits(ref.externalId)}`,
    );
    const budgetResource = (rows[0] as { campaign?: { campaignBudget?: string } } | undefined)
      ?.campaign?.campaignBudget;
    if (!budgetResource) throw new ConnectorError("Campaign budget not found", "google");
    await this.call("campaignBudgets:mutate", {
      operations: [
        {
          update: {
            resourceName: budgetResource,
            amountMicros: String(minorToMicros(dailyBudgetMinor, ref.currency)),
          },
          updateMask: "amount_micros",
        },
      ],
    });
    return { manual: false };
  }

  spendQuery(externalId: string, since: string, until: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      throw new ConnectorError("Invalid date range", "google");
    }
    return `SELECT segments.date, metrics.cost_micros FROM campaign WHERE campaign.id = ${digits(externalId)} AND segments.date BETWEEN '${since}' AND '${until}'`;
  }

  private async search(query: string): Promise<unknown[]> {
    const json = await this.call("googleAds:searchStream", { query });
    const batches = Array.isArray(json) ? json : [json];
    return batches.flatMap((b) => ((b as { results?: unknown[] }).results ?? []) as unknown[]);
  }

  async fetchDailySpend(ref: ExternalCampaignRef, since: string, until: string): Promise<DailySpend[]> {
    const rows = await this.search(this.spendQuery(ref.externalId, since, until));
    const byDate = new Map<string, number>();
    for (const row of rows as Array<{
      segments?: { date?: string };
      metrics?: { costMicros?: string | number };
    }>) {
      const date = row.segments?.date;
      if (!date) continue;
      const minor = microsToMinor(row.metrics?.costMicros ?? 0, ref.currency);
      byDate.set(date, (byDate.get(date) ?? 0) + minor);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, spendMinor]) => ({ date, spendMinor }));
  }
}

// ---------------------------------------------------------------------------
// OAuth (Google Identity, offline access for a refresh token)
// ---------------------------------------------------------------------------

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export function googleAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }) {
  const params = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: GOOGLE_ADS_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: p.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function tokenRequest(
  params: Record<string, string>,
  f: FetchLike,
): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number }> {
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || json.error) {
    throw new ConnectorError(
      `Google OAuth error: ${json.error_description ?? json.error ?? res.status}`,
      "google",
      res.status,
      json.error,
    );
  }
  return json;
}

export async function exchangeGoogleCode(p: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetch?: FetchLike;
}): Promise<{ refreshToken: string }> {
  const json = await tokenRequest(
    {
      grant_type: "authorization_code",
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
    },
    p.fetch ?? ((i, init) => globalThis.fetch(i, init)),
  );
  if (!json.refresh_token) {
    throw new ConnectorError("Google did not return a refresh token (re-consent required)", "google");
  }
  return { refreshToken: json.refresh_token };
}

export async function refreshGoogleAccessToken(p: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: FetchLike;
}): Promise<string> {
  const json = await tokenRequest(
    {
      grant_type: "refresh_token",
      refresh_token: p.refreshToken,
      client_id: p.clientId,
      client_secret: p.clientSecret,
    },
    p.fetch ?? ((i, init) => globalThis.fetch(i, init)),
  );
  if (!json.access_token) throw new ConnectorError("Google did not return an access token", "google");
  return json.access_token;
}
