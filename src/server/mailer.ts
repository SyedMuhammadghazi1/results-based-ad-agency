import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/env";
import { logger } from "./logger";

export type Email = { to: string | string[]; subject: string; text: string; html?: string };

/** Sent emails are kept in memory when SMTP is not configured (dev/test inspection). */
export const outbox: Email[] = [];

let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  transporter = env.SMTP_HOST
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      })
    : null;
  return transporter;
}

export async function sendEmail(email: Email): Promise<void> {
  const t = getTransporter();
  const recipients = Array.isArray(email.to) ? email.to : [email.to];
  if (recipients.length === 0) return;
  if (!t) {
    if (outbox.length > 500) outbox.shift();
    outbox.push(email);
    // Never log recipients or bodies (PII); the subject is enough to debug locally.
    logger.info(
      { subject: email.subject, recipients: recipients.length },
      "email (SMTP not configured)",
    );
    return;
  }
  await t.sendMail({ from: env.EMAIL_FROM, ...email, to: recipients });
  logger.info({ subject: email.subject, recipients: recipients.length }, "email sent");
}
