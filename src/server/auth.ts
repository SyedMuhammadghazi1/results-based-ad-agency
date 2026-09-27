import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/db";
import { account, session, user, verification } from "@/db/schema";
import { appName, env, isProduction } from "@/env";
import { sendEmail } from "./mailer";

export const MIN_PASSWORD_LENGTH = 10;

export const auth = betterAuth({
  appName,
  baseURL: env.BETTER_AUTH_URL ?? env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.BETTER_AUTH_URL ?? env.APP_URL],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxPasswordLength: 128,
    autoSignIn: true,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user: u, url }) => {
      await sendEmail({
        to: u.email,
        subject: `Reset your ${appName} password`,
        text: `Someone asked to reset the password for this account.\n\nReset it here (valid for 1 hour): ${url}\n\nIf this wasn't you, ignore this email.`,
      });
    },
  },
  user: {
    additionalFields: {
      // Users can never set their own role: `input: false` rejects it on sign-up/update.
      role: { type: "string", required: false, defaultValue: "client", input: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  // Auth endpoints are rate limited by our Postgres limiter in the route handler, which works
  // across instances; Better Auth's in-memory limiter is disabled to avoid double counting.
  rateLimit: { enabled: false },
  advanced: {
    useSecureCookies: isProduction && (env.BETTER_AUTH_URL ?? env.APP_URL).startsWith("https://"),
  },
  plugins: [nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;
