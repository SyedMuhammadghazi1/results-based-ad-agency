"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/db";
import { applications } from "@/db/schema";
import type { ActionState } from "@/lib/action-state";
import { actionError, formToObject } from "@/server/actions";
import { raiseAlert } from "@/server/alerts";
import { clientIp } from "@/server/client-ip";
import { rateLimitByIp } from "@/server/rate-limit";
import { REVENUE_BANDS, SPEND_BANDS } from "./bands";

const applySchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().max(200),
  company: z.string().trim().min(2).max(160),
  website: z.string().trim().min(4).max(300),
  monthlyRevenueBand: z.enum(REVENUE_BANDS),
  monthlyAdSpendBand: z.enum(SPEND_BANDS),
  message: z.string().trim().max(2000).optional().default(""),
  // Honeypot: real users never fill this in.
  company_url: z.string().max(0).optional(),
});

export async function submitApplication(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const limit = await rateLimitByIp("apply", clientIp(await headers()), 5, 3600, "shared");
    if (limit && !limit.allowed)
      return { ok: false, message: "Too many submissions. Please try again later." };
    const input = applySchema.parse(formToObject(fd));
    await db.insert(applications).values({
      name: input.name,
      email: input.email.toLowerCase(),
      company: input.company,
      website: input.website,
      monthlyRevenueBand: input.monthlyRevenueBand,
      monthlyAdSpendBand: input.monthlyAdSpendBand,
      message: input.message,
    });
    await raiseAlert({
      kind: "new_application",
      severity: "warning",
      message: `New application from ${input.company}`,
      data: { company: input.company },
    });
    return {
      ok: true,
      message: "Thanks! We'll review your application and reply within two business days.",
    };
  } catch (err) {
    return actionError(err, "apply");
  }
}
