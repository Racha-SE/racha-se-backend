import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branch } from "./branch";
import { createdAtColumn, updatedAtColumn } from "./helpers";

export const userTypeEnum = pgEnum("user_type", [
  "hq",
  "branch",
  "cashier",
  "customer",
]);

export const user = pgTable(
  "user",
  {
    id: text("user_id").primaryKey(),

    // better-auth core fields (see node_modules/@better-auth/core/dist/db/schema/{shared,user}.mjs) —
    // required as-is, don't rename without also setting `user.fields` in the auth config.
    email: varchar("email", { length: 255 }).notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: varchar("name", { length: 255 }).notNull(),
    image: text("image"),

    // better-auth `admin` plugin fields (see node_modules/better-auth/dist/plugins/admin/schema.mjs)
    // — gates /admin/create-user and friends. Independent of `userType`
    // below: `role` controls who may manage accounts via the admin API,
    // `userType` is our own business role used throughout the schema.
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires"),

    // business fields — passwordHash intentionally absent: better-auth stores
    // credentials in its own `account` table, not on `user`.
    userType: userTypeEnum("user_type").notNull(),
    firstname: varchar("firstname", { length: 255 }).notNull(),
    lastname: varchar("lastname", { length: 255 }).notNull(),
    username: varchar("username", { length: 255 }).notNull().unique(),
    isActive: boolean("is_active").notNull(),
    birthdate: varchar("birthdate", { length: 255 }),
    branchId: integer("branch_id").references(() => branch.branchId),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    branchRequiredForBranchOrCashier: check(
      "branch_required_for_branch_or_cashier",
      sql`(${table.userType} NOT IN ('branch', 'cashier')) OR (${table.branchId} IS NOT NULL)`,
    ),
  }),
);
