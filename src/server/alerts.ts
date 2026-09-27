import { inArray } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { alerts, user, type AlertKind } from "@/db/schema";
import { appName, env } from "@/env";
import { logger } from "./logger";
import { sendEmail } from "./mailer";

export type NewAlert = {
  orgId?: string | null;
  kind: AlertKind;
  severity: "info" | "warning" | "critical";
  message: string;
  /** Alerts with the same dedupe key are only raised once (jobs are re-runnable). */
  dedupeKey?: string;
  data?: Record<string, unknown>;
};

export async function operatorEmails(tx: Executor = db): Promise<string[]> {
  if (env.OPERATOR_ALERT_EMAIL) return [env.OPERATOR_ALERT_EMAIL];
  const rows = await tx
    .select({ email: user.email })
    .from(user)
    .where(inArray(user.role, ["operator", "admin"]));
  return rows.map((r) => r.email);
}

/** Inserts an alert (idempotent by dedupe key) and emails operators. Returns true if new. */
export async function raiseAlert(a: NewAlert, tx: Executor = db): Promise<boolean> {
  const inserted = await tx
    .insert(alerts)
    .values({
      orgId: a.orgId ?? null,
      kind: a.kind,
      severity: a.severity,
      message: a.message,
      dedupeKey: a.dedupeKey ?? null,
      data: a.data ?? {},
    })
    .onConflictDoNothing({ target: alerts.dedupeKey })
    .returning({ id: alerts.id });
  if (inserted.length === 0) return false;
  logger.warn({ kind: a.kind, orgId: a.orgId }, "operator alert raised");
  if (a.severity !== "info") {
    try {
      await sendEmail({
        to: await operatorEmails(tx),
        subject: `[${appName}] ${a.severity.toUpperCase()}: ${a.message}`,
        text: `${a.message}\n\nOpen the operator console: ${env.APP_URL}/operator/alerts`,
      });
    } catch (err) {
      logger.error({ err }, "failed to email operator alert");
    }
  }
  return true;
}
