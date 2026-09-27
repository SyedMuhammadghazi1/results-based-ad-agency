import type { ConnectorKind, Objective } from "@/db/schema";

/**
 * Ad-platform connector contract. Implementations: SandboxConnector (deterministic, for
 * dev/test/demo), MetaMarketingConnector, GoogleAdsConnector and ManualConnector (for campaigns
 * operators manage by hand in the platform UI).
 */

export type CreateCampaignInput = {
  name: string;
  objective: Objective;
  dailyBudgetMinor: number;
  currency: string;
  landingUrl: string;
  trackingCode: string;
};

export type ExternalCampaignRef = {
  externalId: string;
  dailyBudgetMinor: number;
  currency: string;
};

export type DailySpend = { date: string; spendMinor: number };

export type ActionResult = {
  /** True when nothing happened on the platform and an operator must act by hand. */
  manual: boolean;
};

export interface AdConnector {
  readonly kind: ConnectorKind;
  createCampaign(input: CreateCampaignInput): Promise<{ externalId: string }>;
  setStatus(ref: ExternalCampaignRef, status: "active" | "paused"): Promise<ActionResult>;
  setDailyBudget(ref: ExternalCampaignRef, dailyBudgetMinor: number): Promise<ActionResult>;
  /** Inclusive YYYY-MM-DD range. Days without spend may be omitted. */
  fetchDailySpend(ref: ExternalCampaignRef, since: string, until: string): Promise<DailySpend[]>;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly platform: string,
    readonly status?: number,
    readonly platformCode?: string | number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
