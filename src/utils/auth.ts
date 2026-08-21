import { betterAuth } from "better-auth";
import { admin, openAPI } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db/client";
import * as schema from "@/db/schema";

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
