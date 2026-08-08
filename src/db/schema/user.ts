import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  serial,
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
    userId: serial("user_id").primaryKey(),
    userType: userTypeEnum("user_type").notNull(),
    firstname: varchar("firstname", { length: 255 }).notNull(),
    lastname: varchar("lastname", { length: 255 }).notNull(),
    username: varchar("username", { length: 255 }).notNull().unique(),
    isActive: boolean("is_active").notNull(),
    birthdate: varchar("birthdate", { length: 255 }),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    createdAt: createdAtColumn(),
    branchId: integer("branch_id").references(() => branch.branchId),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    branchRequiredForBranchOrCashier: check(
      "branch_required_for_branch_or_cashier",
      sql`(${table.userType} NOT IN ('branch', 'cashier')) OR (${table.branchId} IS NOT NULL)`,
    ),
  }),
);
