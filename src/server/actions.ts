import { ZodError } from "zod";
import { unstable_rethrow } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { ConnectorError } from "@/lib/connectors/types";
import { MoneyParseError } from "@/lib/money";
import { logger } from "./logger";
import { DomainError } from "./orgs";

/** Maps expected errors to user-facing messages; unexpected errors get a generic message. */
export function actionError(err: unknown, context: string): ActionState {
  unstable_rethrow(err);
  if (err instanceof ZodError) {
    return {
      ok: false,
      message: "Please fix the highlighted problems.",
      errors: err.issues.map((i) =>
        i.path.length ? `${humanize(String(i.path[0]))}: ${i.message}` : i.message,
      ),
    };
  }
  if (err instanceof DomainError || err instanceof MoneyParseError)
    return { ok: false, message: err.message };
  if (err instanceof ConnectorError)
    return { ok: false, message: `Ad platform error: ${err.message}` };
  logger.error({ err, context }, "server action failed");
  return { ok: false, message: "Something went wrong. Please try again." };
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

export function formToObject(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries())
    if (typeof v === "string" && !k.startsWith("$ACTION")) out[k] = v;
  return out;
}
