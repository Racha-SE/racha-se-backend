import nodemailer from "nodemailer";

// Built once and reused, same pattern as src/db/client.ts's `db` and this
// directory's own auth.ts's `auth` — not a factory, just a shared instance.
export const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
});

/**
 * Checks the SMTP connection at startup (called from src/index.ts) so a
 * misconfigured/unreachable SMTP provider shows up in the boot log instead
 * of silently failing later — better-auth swallows sendResetPassword errors
 * into a generic background-task log line with no context, so this is the
 * only place a broken config surfaces clearly. Non-fatal on purpose: the
 * rest of the API works fine without email, so a bad SMTP config shouldn't
 * take the whole server down.
 */
export async function verifyMailerConnection(): Promise<void> {
  const target = `${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`;
  try {
    await mailer.verify();
    console.log(`Mailer connected (SMTP ${target})`);
  } catch (error) {
    console.error(
      `Mailer failed to connect (SMTP ${target}) — emails (forgot/reset password) won't send until this is fixed:`,
      error,
    );
  }
}
