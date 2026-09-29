import { describe, expect, it } from "vitest";
import { envValidationSkipped, loadEnv } from "@/env";

const VALID = {
  DATABASE_URL: "postgres://u:p@localhost:5432/app",
  BETTER_AUTH_SECRET: "a-real-secret-0123456789abcdef0123456789",
  DATA_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  CRON_SECRET: "a-real-cron-secret-000",
};
// Secrets deliberately missing, as in a `next build` image or a misconfigured deploy.
const MISSING_SECRETS = { DATABASE_URL: VALID.DATABASE_URL };

const source = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe("SKIP_ENV_VALIDATION", () => {
  it("is ignored by a running production server: missing secrets fail fast", () => {
    const runtime = source({
      ...MISSING_SECRETS,
      NODE_ENV: "production",
      SKIP_ENV_VALIDATION: "1",
    });
    expect(envValidationSkipped(runtime)).toBe(false);
    expect(() => loadEnv(runtime)).toThrow(/Invalid environment configuration/);
    expect(() => loadEnv({ ...runtime, SKIP_ENV_VALIDATION: "true" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("applies during `next build` (NEXT_PHASE=phase-production-build) without inventing values", () => {
    const build = source({
      ...MISSING_SECRETS,
      NODE_ENV: "production",
      SKIP_ENV_VALIDATION: "1",
      NEXT_PHASE: "phase-production-build",
    });
    expect(envValidationSkipped(build)).toBe(true);
    const env = loadEnv(build);
    // Missing secrets stay undefined (code that needs them fails loudly) — never placeholders.
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.DATA_ENCRYPTION_KEY).toBeUndefined();
    expect(env.CRON_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.NODE_ENV).toBe("production");
  });

  it("other Next phases in production (e.g. the server) do not count as the build", () => {
    const server = source({
      ...MISSING_SECRETS,
      NODE_ENV: "production",
      SKIP_ENV_VALIDATION: "1",
      NEXT_PHASE: "phase-production-server",
    });
    expect(envValidationSkipped(server)).toBe(false);
    expect(() => loadEnv(server)).toThrow(/Invalid environment configuration/);
  });

  it("still relaxes validation for CI / dev tooling outside production", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const tooling = source({ ...MISSING_SECRETS, NODE_ENV, SKIP_ENV_VALIDATION: "1" });
      expect(envValidationSkipped(tooling)).toBe(true);
      expect(loadEnv(tooling).BETTER_AUTH_SECRET).toBeUndefined();
    }
  });

  it("validates normally when the flag is not set", () => {
    expect(envValidationSkipped(source({ NODE_ENV: "development" }))).toBe(false);
    expect(() => loadEnv(source({ ...MISSING_SECRETS, NODE_ENV: "development" }))).toThrow(
      /Invalid environment configuration/,
    );
    const env = loadEnv(source({ ...VALID, NODE_ENV: "production" }));
    expect(env.BETTER_AUTH_SECRET).toBe(VALID.BETTER_AUTH_SECRET);
  });
});

describe("client IP settings", () => {
  const base = { ...VALID, NODE_ENV: "production" };

  it("defaults to one trusted proxy hop and no platform header", () => {
    const env = loadEnv(source(base));
    expect(env.TRUSTED_PROXY_HOPS).toBe(1);
    expect(env.CLIENT_IP_HEADER).toBeUndefined();
    expect(loadEnv(source({ ...base, TRUSTED_PROXY_HOPS: "" })).TRUSTED_PROXY_HOPS).toBe(1);
    expect(loadEnv(source({ ...base, TRUSTED_PROXY_HOPS: "0" })).TRUSTED_PROXY_HOPS).toBe(0);
    expect(loadEnv(source({ ...base, TRUSTED_PROXY_HOPS: "2" })).TRUSTED_PROXY_HOPS).toBe(2);
  });

  it("rejects invalid hop counts", () => {
    for (const TRUSTED_PROXY_HOPS of ["-1", "1.5", "yes"]) {
      expect(() => loadEnv(source({ ...base, TRUSTED_PROXY_HOPS }))).toThrow(/TRUSTED_PROXY_HOPS/);
    }
  });

  it("accepts a platform header (lower-cased) but never a client-appendable list", () => {
    expect(loadEnv(source({ ...base, CLIENT_IP_HEADER: "X-Real-IP" })).CLIENT_IP_HEADER).toBe(
      "x-real-ip",
    );
    for (const CLIENT_IP_HEADER of ["X-Forwarded-For", "forwarded", "bad header"]) {
      expect(() => loadEnv(source({ ...base, CLIENT_IP_HEADER }))).toThrow(/CLIENT_IP_HEADER/);
    }
  });
});
