import { createHash } from "node:crypto";
import { dateRange } from "../dates";
import type {
  ActionResult,
  AdConnector,
  CreateCampaignInput,
  DailySpend,
  ExternalCampaignRef,
} from "./types";

export type SandboxCall =
  | { op: "createCampaign"; input: CreateCampaignInput }
  | { op: "setStatus"; externalId: string; status: "active" | "paused" }
  | { op: "setDailyBudget"; externalId: string; dailyBudgetMinor: number }
  | { op: "fetchDailySpend"; externalId: string; since: string; until: string };

/** Deterministic pseudo-random fraction in [0, 1) for a string seed. */
export function seededFraction(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Deterministic fake ad platform. The same campaign + date always reports the same spend
 * (55–100% of the daily budget), so jobs and tests are reproducible. No network calls.
 */
export class SandboxConnector implements AdConnector {
  readonly kind = "sandbox" as const;
  readonly calls: SandboxCall[] = [];

  async createCampaign(input: CreateCampaignInput) {
    this.calls.push({ op: "createCampaign", input });
    const id = createHash("sha256").update(`${input.trackingCode}:${input.name}`).digest("hex");
    return { externalId: `sbx_${id.slice(0, 16)}` };
  }

  async setStatus(ref: ExternalCampaignRef, status: "active" | "paused"): Promise<ActionResult> {
    this.calls.push({ op: "setStatus", externalId: ref.externalId, status });
    return { manual: false };
  }

  async setDailyBudget(ref: ExternalCampaignRef, dailyBudgetMinor: number): Promise<ActionResult> {
    this.calls.push({ op: "setDailyBudget", externalId: ref.externalId, dailyBudgetMinor });
    return { manual: false };
  }

  async fetchDailySpend(
    ref: ExternalCampaignRef,
    since: string,
    until: string,
  ): Promise<DailySpend[]> {
    this.calls.push({ op: "fetchDailySpend", externalId: ref.externalId, since, until });
    return dateRange(new Date(`${since}T00:00:00Z`), new Date(`${until}T00:00:00Z`)).map(
      (date) => ({
        date,
        spendMinor: Math.round(
          ref.dailyBudgetMinor * (0.55 + 0.45 * seededFraction(`${ref.externalId}:${date}`)),
        ),
      }),
    );
  }
}

/**
 * For campaigns operators run by hand in the platform UI (e.g. TikTok, or before API access is
 * approved). Nothing is sent anywhere; callers raise an operator alert when `manual` is true.
 */
export class ManualConnector implements AdConnector {
  readonly kind = "manual" as const;

  async createCampaign(input: CreateCampaignInput) {
    return { externalId: `manual_${input.trackingCode}` };
  }

  async setStatus(): Promise<ActionResult> {
    return { manual: true };
  }

  async setDailyBudget(): Promise<ActionResult> {
    return { manual: true };
  }

  async fetchDailySpend(): Promise<DailySpend[]> {
    return [];
  }
}
