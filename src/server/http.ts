import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger } from "./logger";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

export const unauthorized = () => new ApiError(401, "unauthorized", "Authentication required");
export const forbidden = () => new ApiError(403, "forbidden", "You do not have access");
export const notFound = () => new ApiError(404, "not_found", "Not found");

export function jsonError(status: number, code: string, message?: string, headers?: HeadersInit) {
  return NextResponse.json({ error: { code, message: message ?? code } }, { status, headers });
}

/** Converts thrown errors into safe JSON responses (no stack traces leak). */
export function handleRouteError(err: unknown, context: string): NextResponse {
  if (err instanceof ApiError) return jsonError(err.status, err.code, err.message);
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_request",
          message: "Request validation failed",
          issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 400 },
    );
  }
  logger.error({ err, context }, "unhandled route error");
  return jsonError(500, "internal_error", "Something went wrong");
}

/** Client IP from the reverse proxy chain (first hop). Only used for rate limits and audit. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim().slice(0, 64);
  return headers.get("x-real-ip")?.trim().slice(0, 64) ?? "unknown";
}

export function bearerToken(headers: Headers): string | null {
  const h = headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}
