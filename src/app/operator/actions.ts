"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { USER_ROLES } from "@/db/schema";
import { executeJob, isJobName } from "@/jobs";
import type { ActionState } from "@/lib/action-state";
import { addDays, startOfUtcDay } from "@/lib/dates";
import { actionError, formToObject } from "@/server/actions";
import {
  createCampaign,
  getCampaign,
  setCampaignStatus,
  syncCampaignSpend,
  updateCampaign,
} from "@/server/campaigns";
import { requireAdmin, requireOperator } from "@/server/guards";
import { setAdAccount } from "@/server/integrations";
import { resolveAlert, setUserRole } from "@/server/operator";
import { setOffer } from "@/server/orgs";

const uuid = z.uuid();

export async function createCampaignAction(
  orgId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  let id: string;
  try {
    const op = await requireOperator();
    const campaign = await createCampaign(op, uuid.parse(orgId), formToObject(fd) as never);
    id = campaign.id;
  } catch (err) {
    return actionError(err, "campaign.create");
  }
  redirect(`/operator/campaigns/${id}`);
}

export async function updateCampaignAction(
  campaignId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  try {
    const op = await requireOperator();
    await updateCampaign(op, uuid.parse(campaignId), formToObject(fd) as never);
    revalidatePath(`/operator/campaigns/${campaignId}`);
    return { ok: true, message: "Campaign saved." };
  } catch (err) {
    return actionError(err, "campaign.update");
  }
}

export async function campaignStatusAction(
  campaignId: string,
  status: "active" | "paused" | "archived",
  _prev: ActionState,
): Promise<ActionState> {
  try {
    const op = await requireOperator();
    const campaign = await getCampaign(uuid.parse(campaignId));
    if (!campaign) return { ok: false, message: "Campaign not found" };
    const res = await setCampaignStatus(op, campaign, status, { reason: "manual" });
    revalidatePath(`/operator/campaigns/${campaignId}`);
    return {
      ok: true,
      message: res.manual
        ? `Marked ${status}. This campaign is managed by hand — apply the change in the ad platform (an alert was raised).`
        : `Campaign ${status === "active" ? "launched" : status}.`,
    };
  } catch (err) {
    return actionError(err, "campaign.status");
  }
}

export async function syncSpendAction(campaignId: string): Promise<ActionState> {
  try {
    await requireOperator();
    const campaign = await getCampaign(uuid.parse(campaignId));
    if (!campaign) return { ok: false, message: "Campaign not found" };
    const today = startOfUtcDay(new Date());
    const n = await syncCampaignSpend(campaign, addDays(today, -6), today);
    revalidatePath(`/operator/campaigns/${campaignId}`);
    return { ok: true, message: `Synced ${n} day(s) of spend.` };
  } catch (err) {
    return actionError(err, "campaign.sync");
  }
}

export async function setOfferAction(
  orgId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  try {
    const op = await requireOperator();
    await setOffer(uuid.parse(orgId), op, formToObject(fd) as never);
    revalidatePath(`/operator/orgs/${orgId}`);
    return {
      ok: true,
      message: "Offer updated. The client must accept the new agreement version for it to apply.",
    };
  } catch (err) {
    return actionError(err, "offer.update");
  }
}

export async function setAdAccountAction(
  orgId: string,
  kind: "meta_ads" | "google_ads",
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  try {
    const op = await requireOperator();
    await setAdAccount(uuid.parse(orgId), kind, formToObject(fd) as never, op);
    revalidatePath(`/operator/orgs/${orgId}`);
    return { ok: true, message: "Ad account saved." };
  } catch (err) {
    return actionError(err, "integration.ad_account");
  }
}

export async function resolveAlertAction(alertId: string): Promise<ActionState> {
  try {
    const op = await requireOperator();
    await resolveAlert(uuid.parse(alertId), op);
    revalidatePath("/operator/alerts");
    return { ok: true, message: "Resolved." };
  } catch (err) {
    return actionError(err, "alert.resolve");
  }
}

export async function setRoleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const admin = await requireAdmin();
    const input = z.object({ email: z.email(), role: z.enum(USER_ROLES) }).parse(formToObject(fd));
    const res = await setUserRole(admin, input.email, input.role);
    revalidatePath("/operator/team");
    return { ok: res.ok, message: res.message };
  } catch (err) {
    return actionError(err, "user.role");
  }
}

export async function runJobAction(job: string): Promise<ActionState> {
  try {
    await requireOperator();
    if (!isJobName(job) || job === "monthly-billing")
      return { ok: false, message: "This job can't be run from the console." };
    const res = await executeJob(job);
    revalidatePath("/operator/jobs");
    return res.ok
      ? { ok: true, message: `${job}: ${JSON.stringify(res.summary)}` }
      : { ok: false, message: res.error };
  } catch (err) {
    return actionError(err, "job.run");
  }
}
