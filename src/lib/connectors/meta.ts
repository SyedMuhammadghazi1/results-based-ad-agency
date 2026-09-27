import { createHmac } from "node:crypto";
import { parseDecimalToMinor } from "../money";
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
 * Meta Marketing API connector (Graph API over plain fetch).
 *
 * Requires an access token with `ads_management` + `ads_read` for the client's ad account.
 * Production use needs Meta App Review / Advanced Access for those permissions and a Business
 * Verification — see docs/DEPLOYMENT.md. Budgets are sent in the ad account currency's minor
 * units (Meta's convention), insights `spend` comes back as a major-unit decimal string.
 */

export const META_OBJECTIVES: Record<Objective, string> = {
  sales: "OUTCOME_SALES",
  leads: "OUTCOME_LEADS",
  traffic: "OUTCOME_TRAFFIC",
  awareness: "OUTCOME_AWARENESS",
};

export type MetaConfig = {
  accessToken: string;
  /** Numeric ad account id, with or without the `act_` prefix. */
  adAccountId: string;
  appSecret?: string;
  apiVersion: string;
  fetch?: FetchLike;
};

type GraphError = { error?: { message?: string; code?: number; type?: string } };

export class MetaMarketingConnector implements AdConnector {
  readonly kind = "meta" as const;
  private readonly fetch: FetchLike;
  private readonly base: string;

  constructor(private readonly cfg: MetaConfig) {
    this.fetch = cfg.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.base = `https://graph.facebook.com/${cfg.apiVersion}`;
  }

  private get accountPath(): string {
    const id = this.cfg.adAccountId.replace(/^act_/, "");
    if (!/^\d+$/.test(id)) throw new ConnectorError("Invalid Meta ad account id", "meta");
    return `act_${id}`;
  }

  /** Auth params added to every call (`appsecret_proof` when the app secret is known). */
  authParams(): Record<string, string> {
    const params: Record<string, string> = { access_token: this.cfg.accessToken };
    if (this.cfg.appSecret) {
      params.appsecret_proof = createHmac("sha256", this.cfg.appSecret)
        .update(this.cfg.accessToken)
        .digest("hex");
    }
    return params;
  }

  private async post(path: string, params: Record<string, string>): Promise<unknown> {
    const body = new URLSearchParams({ ...params, ...this.authParams() });
    const res = await this.fetch(`${this.base}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return this.parse(res);
  }

  private async get(url: string): Promise<unknown> {
    const res = await this.fetch(url, { method: "GET" });
    return this.parse(res);
  }

  private async parse(res: Response): Promise<unknown> {
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ConnectorError(`Meta API returned non-JSON (HTTP ${res.status})`, "meta", res.status);
    }
    const err = (json as GraphError).error;
    if (!res.ok || err) {
      throw new ConnectorError(
        `Meta API error: ${err?.message ?? `HTTP ${res.status}`}`,
        "meta",
        res.status,
        err?.code,
      );
    }
    return json;
  }

  async createCampaign(input: CreateCampaignInput) {
    const json = (await this.post(`${this.accountPath}/campaigns`, {
      name: input.name,
      objective: META_OBJECTIVES[input.objective],
      status: "PAUSED",
      special_ad_categories: "[]",
      buying_type: "AUCTION",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      daily_budget: String(input.dailyBudgetMinor),
    })) as { id?: string };
    if (!json.id) throw new ConnectorError("Meta API did not return a campaign id", "meta");
    return { externalId: json.id };
  }

  async setStatus(ref: ExternalCampaignRef, status: "active" | "paused"): Promise<ActionResult> {
    await this.post(encodeURIComponent(ref.externalId), {
      status: status === "active" ? "ACTIVE" : "PAUSED",
    });
    return { manual: false };
  }

  async setDailyBudget(ref: ExternalCampaignRef, dailyBudgetMinor: number): Promise<ActionResult> {
    await this.post(encodeURIComponent(ref.externalId), { daily_budget: String(dailyBudgetMinor) });
    return { manual: false };
  }

  insightsUrl(ref: ExternalCampaignRef, since: string, until: string): string {
    const params = new URLSearchParams({
      fields: "spend,date_start,date_stop",
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      limit: "100",
      ...this.authParams(),
    });
    return `${this.base}/${encodeURIComponent(ref.externalId)}/insights?${params.toString()}`;
  }

  async fetchDailySpend(ref: ExternalCampaignRef, since: string, until: string): Promise<DailySpend[]> {
    const out: DailySpend[] = [];
    let url: string | undefined = this.insightsUrl(ref, since, until);
    for (let page = 0; url && page < 50; page++) {
      const json = (await this.get(url)) as {
        data?: Array<{ spend?: string; date_start?: string }>;
        paging?: { next?: string };
      };
      for (const row of json.data ?? []) {
        if (!row.date_start) continue;
        out.push({
          date: row.date_start,
          spendMinor: parseDecimalToMinor(row.spend ?? "0", ref.currency),
        });
      }
      url = json.paging?.next;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// OAuth (Facebook Login for Business)
// ---------------------------------------------------------------------------

export const META_SCOPES = ["ads_management", "ads_read", "business_management"];

export function metaAuthorizeUrl(p: {
  appId: string;
  redirectUri: string;
  state: string;
  apiVersion: string;
}): string {
  const params = new URLSearchParams({
    client_id: p.appId,
    redirect_uri: p.redirectUri,
    state: p.state,
    response_type: "code",
    scope: META_SCOPES.join(","),
  });
  return `https://www.facebook.com/${p.apiVersion}/dialog/oauth?${params.toString()}`;
}

/** Exchanges the OAuth code for a short-lived token, then for a long-lived (~60 day) token. */
export async function exchangeMetaCode(p: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
  apiVersion: string;
  fetch?: FetchLike;
}): Promise<{ accessToken: string; expiresIn: number | null }> {
  const f: FetchLike = p.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const base = `https://graph.facebook.com/${p.apiVersion}/oauth/access_token`;
  const short = await f(
    `${base}?${new URLSearchParams({
      client_id: p.appId,
      client_secret: p.appSecret,
      redirect_uri: p.redirectUri,
      code: p.code,
    }).toString()}`,
  );
  const shortJson = (await short.json()) as { access_token?: string } & GraphError;
  if (!short.ok || !shortJson.access_token) {
    throw new ConnectorError(
      `Meta code exchange failed: ${shortJson.error?.message ?? short.status}`,
      "meta",
      short.status,
    );
  }
  const long = await f(
    `${base}?${new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: p.appId,
      client_secret: p.appSecret,
      fb_exchange_token: shortJson.access_token,
    }).toString()}`,
  );
  const longJson = (await long.json()) as { access_token?: string; expires_in?: number } & GraphError;
  if (!long.ok || !longJson.access_token) {
    throw new ConnectorError(
      `Meta long-lived token exchange failed: ${longJson.error?.message ?? long.status}`,
      "meta",
      long.status,
    );
  }
  return { accessToken: longJson.access_token, expiresIn: longJson.expires_in ?? null };
}
