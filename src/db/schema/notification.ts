import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  serial,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branch } from "./branch";
import { createdAtColumn } from "./helpers";
import { order } from "./order";
import { product } from "./product";

export const notificationTypeEnum = pgEnum("notification_type", [
  "expire",
  "min_stock",
]);

// branchId null = HQ-scoped notification, otherwise scoped to that branch.
//
// Column meaning depends on type (snapshot at creation time, not a live join):
// - "expire": lotId + pId identify which lot/product, quantity is how many
//   units in that lot, expiredDate is when it expires.
// - "min_stock": quantity is the remaining stock for that product/scope at
//   creation time; lotId and expiredDate are unused (a low-stock alert isn't
//   tied to one lot).
export const notification = pgTable(
  "notification",
  {
    notificationId: serial("notification_id").primaryKey(),
    type: notificationTypeEnum("type").notNull(),
    branchId: integer("branch_id").references(() => branch.branchId),
    pId: integer("p_id")
      .notNull()
      .references(() => product.pId),
    quantity: integer("quantity").notNull(),
    lotId: integer("lot_id").references(() => order.lotId),
    expiredDate: timestamp("expired_date"),
    isResolved: boolean("is_resolved").notNull().default(false),
    resolvedAt: timestamp("resolved_at"),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    expireFieldsRequired: check(
      "notification_expire_fields_required",
      sql`${table.type} <> 'expire' OR (${table.lotId} IS NOT NULL AND ${table.expiredDate} IS NOT NULL)`,
    ),
    quantityNonNegative: check(
      "notification_quantity_nonnegative",
      sql`${table.quantity} >= 0`,
    ),
  }),
);
