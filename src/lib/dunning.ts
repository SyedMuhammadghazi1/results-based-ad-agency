import { DAY_MS } from "./dates";
import type { BillingStatus } from "@/db/schema";

/** An issued, unpaid invoice older than the grace period is overdue (pure). */
export function isOverdue(
  invoice: { status: BillingStatus; issuedAt: Date | null },
  now: Date,
  graceDays: number,
): boolean {
  if (invoice.status !== "open" && invoice.status !== "payment_failed") return false;
  if (!invoice.issuedAt) return false;
  return now.getTime() - invoice.issuedAt.getTime() > graceDays * DAY_MS;
}
