import { auditLog } from "@/db/schema";
import { db, type Executor } from "@/db";
import { logger } from "./logger";

export type AuditEntry = {
  actorUserId?: string | null;
  actorRole?: string | null;
  orgId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  metadata?: Record<string, unknown>;
};

/** Records a sensitive action. Never put secrets or payment details in `metadata`. */
export async function audit(entry: AuditEntry, tx: Executor = db): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    actorRole: entry.actorRole ?? null,
    orgId: entry.orgId ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    ip: entry.ip ?? null,
    metadata: entry.metadata ?? {},
  });
  logger.info({ action: entry.action, orgId: entry.orgId, targetId: entry.targetId }, "audit");
}
