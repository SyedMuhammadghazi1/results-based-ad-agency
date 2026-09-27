import { runDunning as run } from "@/server/billing";
import type { ConnectorResolver } from "@/server/connectors";

/** Daily: pauses campaigns of clients with invoices unpaid longer than DUNNING_GRACE_DAYS. */
export async function runDunningJob(opts: { now?: Date; resolve?: ConnectorResolver } = {}) {
  return run(opts.now ?? new Date(), opts.resolve);
}
