import { betterAuth } from "better-auth";
import { admin, openAPI } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db/client";
import * as schema from "@/db/schema";
import { mailer } from "./mailer";

export const auth = betterAuth({
  basePath: "/api/v1/auth",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  logger: {
    disabled: process.env.NODE_ENV === "test",
  },
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    // Kill every other session once a password's been reset — same reasoning
    // as usersService.deactivate's session wipe: a reset password means any
    // session started under the old one shouldn't be trusted anymore.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      // better-auth calls this via runInBackgroundOrAwait, which on failure
      // only logs a generic "Failed to run background task" with no mention
      // of which email or recipient — log with real context here instead,
      // then swallow it (nothing upstream can act on the error anyway; the
      // request-password-reset response is already sent by this point).
      try {
        await mailer.sendMail({
          from: process.env.SMTP_FROM,
          to: user.email,
          subject: "Reset your password",
          text: `Reset your password: ${url}\n\nIf you didn't request this, ignore this email.`,
          html: `<p>Reset your password by clicking the link below.</p><p><a href="${url}">${url}</a></p><p>If you didn't request this, ignore this email.</p>`,
        });
      } catch (error) {
        console.error(
          `Failed to send reset-password email to ${user.email}:`,
          error,
        );
      }
    },
  },
  trustedOrigins: process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : [],
  plugins: [
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
    }),
    openAPI({
      disableDefaultReference: true,
    }),
  ],
  user: {
    additionalFields: {
      userType: {
        type: ["hq", "branch", "cashier", "customer"],
        required: true,
      },
      firstname: {
        type: "string",
        required: true,
      },
      lastname: {
        type: "string",
        required: true,
      },
      username: {
        type: "string",
        required: true,
      },
      birthdate: {
        type: "string",
        required: false,
      },
      branchId: {
        type: "number",
        required: false,
      },
    },
  },
});
