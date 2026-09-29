"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { actionError, formToObject } from "@/server/actions";
import { startPaymentMethodSetup } from "@/server/billing";
import { requireOrgOwner, requireRole } from "@/server/guards";
import { clientIp } from "@/server/client-ip";
import { ensureIntegrationRow, saveClientStripe, saveShopify } from "@/server/integrations";
import {
  acceptAgreement,
  createOrganization,
  createOrgSchema,
  inviteMember,
  rotateApiKey,
  saveIntake,
  setAllowedOrigins,
} from "@/server/orgs";
import { rateLimit } from "@/server/rate-limit";

export async function createOrgAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const user = await requireRole(["client"]);
    await createOrganization(user, createOrgSchema.parse(formToObject(fd)));
  } catch (err) {
    return actionError(err, "org.create");
  }
  redirect("/onboarding/intake");
}

export async function saveIntakeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const fromSettings = fd.get("returnTo") === "settings";
  try {
    const m = await requireOrgOwner();
    await saveIntake(m.org, m.user, formToObject(fd) as never);
  } catch (err) {
    return actionError(err, "intake.save");
  }
  if (fromSettings) return { ok: true, message: "Business details saved." };
  redirect("/onboarding/agreement");
}

export async function acceptAgreementAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  try {
    const m = await requireOrgOwner();
    if (fd.get("accept") !== "yes")
      return { ok: false, message: "Tick the box to confirm you accept the agreement." };
    const h = await headers();
    await acceptAgreement({
      org: m.org,
      user: m.user,
      shownHash: String(fd.get("termsHash") ?? ""),
      ip: clientIp(h),
      userAgent: h.get("user-agent"),
    });
  } catch (err) {
    return actionError(err, "agreement.accept");
  }
  redirect("/onboarding/tracking");
}

export async function setOriginsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const m = await requireOrgOwner();
    await setAllowedOrigins(m.org, m.user, String(fd.get("origins") ?? ""));
    return { ok: true, message: "Allowed websites saved." };
  } catch (err) {
    return actionError(err, "origins.save");
  }
}

export async function rotateApiKeyAction(): Promise<ActionState> {
  try {
    const m = await requireOrgOwner();
    const limit = await rateLimit("api-key-rotate", m.org.id, 10, 3600);
    if (!limit.allowed) return { ok: false, message: "Too many key rotations. Try again later." };
    const key = await rotateApiKey(m.org, m.user, clientIp(await headers()));
    return {
      ok: true,
      message: "New API key created. Any previous key stopped working.",
      secret: key,
      secretLabel: "Copy your API key now — we only store a hash of it and can't show it again.",
    };
  } catch (err) {
    return actionError(err, "api_key.rotate");
  }
}

export async function prepareIntegrationAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  try {
    const m = await requireOrgOwner();
    const kind = fd.get("kind") === "stripe" ? "stripe" : "shopify";
    await ensureIntegrationRow(m.org.id, kind);
    return { ok: true, message: "Webhook endpoint created — copy the URL below." };
  } catch (err) {
    return actionError(err, "integration.prepare");
  }
}

export async function saveShopifyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const m = await requireOrgOwner();
    await saveShopify(m.org, m.user, formToObject(fd) as never);
    return {
      ok: true,
      message: "Shopify connected. We'll mark it live when the first order webhook arrives.",
    };
  } catch (err) {
    return actionError(err, "integration.shopify");
  }
}

export async function saveStripeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const m = await requireOrgOwner();
    await saveClientStripe(m.org, m.user, formToObject(fd) as never);
    return { ok: true, message: "Stripe webhook secret saved." };
  } catch (err) {
    return actionError(err, "integration.stripe");
  }
}

export async function startPaymentSetupAction(): Promise<ActionState> {
  let url: string;
  try {
    const m = await requireOrgOwner();
    ({ url } = await startPaymentMethodSetup(m.org, m.user));
  } catch (err) {
    return actionError(err, "payment.setup");
  }
  redirect(url);
}

export async function inviteMemberAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const m = await requireOrgOwner();
    const limit = await rateLimit("invite", m.org.id, 20, 3600);
    if (!limit.allowed) return { ok: false, message: "Too many invitations. Try again later." };
    await inviteMember(m.org, m.user, String(fd.get("email") ?? ""));
    return { ok: true, message: "Invitation sent." };
  } catch (err) {
    return actionError(err, "member.invite");
  }
}
