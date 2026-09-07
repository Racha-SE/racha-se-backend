import {
  check,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branch } from "./branch";
import { createdAtColumn, timestamps, updatedAtColumn } from "./helpers";
import { product } from "./product";
import { supplier } from "./supplier";
import { user } from "./user";

export const orderTypeEnum = pgEnum("order_type", ["hq", "branch", "customer"]);

export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "approved",
  "rejected",
  "completed", // branch only
]);

export const order = pgTable("order", {
  lotId: serial("lot_id").primaryKey(),
  orderType: orderTypeEnum("order_type").notNull(),
  createdAt: createdAtColumn(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  status: orderStatusEnum("status").notNull().default("pending"),
  approvedBy: text("approved_by").references(() => user.id),
  approvedAt: timestamp("approved_at"),
  receivedAt: timestamp("received_at"),
  rejectReason: text("reject_reason"),
  updatedAt: updatedAtColumn(),
});

export const headOrderDetail = pgTable(
  "head_order_detail",
  {
    lotId: integer("lot_id")
      .notNull()
      .references(() => order.lotId),
    hodId: serial("hod_id").notNull(),
    amount: integer("amount").notNull(),
    remain: integer("remain").notNull(),
    expiredDate: timestamp("expired_date").notNull(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => supplier.supplierId),
    pId: integer("p_id")
      .notNull()
      .references(() => product.pId),
    basePrice: integer("base_price").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lotId, table.hodId] }),
    // hodId is already unique on its own (serial), but the primary key is
    // composite - branch_order_allocation needs this to reference hod_id alone.
    hodIdUnique: uniqueIndex("head_order_detail_hod_id_unique").on(table.hodId),
    amountNonNegative: check(
      "head_order_detail_amount_nonnegative",
      sql`${table.amount} >= 0`,
    ),
    remainNonNegative: check(
      "head_order_detail_remain_nonnegative",
      sql`${table.remain} >= 0`,
    ),
  }),
);

export const customerOrderDetail = pgTable(
  "customer_order_detail",
  {
    lotId: integer("lot_id")
      .notNull()
      .references(() => order.lotId),
    codId: serial("cod_id").notNull(),
    quantity: integer("quantity").notNull(),
    expiredDate: timestamp("expired_date").notNull(),
    branchId: integer("branch_id")
      .notNull()
      .references(() => branch.branchId),
    pId: integer("p_id")
      .notNull()
      .references(() => product.pId),
    basePrice: integer("unit_price").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lotId, table.codId] }),
    quantityPositive: check(
      "customer_order_detail_quantity_positive",
      sql`${table.quantity} > 0`,
    ),
  }),
);

export const branchOrderDetail = pgTable(
  "branch_order_detail",
  {
    lotId: integer("lot_id")
      .notNull()
      .references(() => order.lotId),
    bodId: serial("bod_id").notNull(),
    amount: integer("amount").notNull(),
    remain: integer("remain").notNull(),
    expiredDate: timestamp("expired_date"),
    branchId: integer("branch_id")
      .notNull()
      .references(() => branch.branchId),
    pId: integer("p_id")
      .notNull()
      .references(() => product.pId),
    basePrice: integer("base_price").notNull().default(0),
    costPrice: integer("cost_price").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lotId, table.bodId] }),
    // Same as head_order_detail: needed so branch_order_allocation can
    // reference bod_id alone.
    bodIdUnique: uniqueIndex("branch_order_detail_bod_id_unique").on(
      table.bodId,
    ),
    amountNonNegative: check(
      "branch_order_detail_amount_nonnegative",
      sql`${table.amount} >= 0`,
    ),
    remainNonNegative: check(
      "branch_order_detail_remain_nonnegative",
      sql`${table.remain} >= 0`,
    ),
  }),
);

/**
 * Which HQ lot(s) a branch order line was filled from, and how much came from
 * each. A branch line item stays one row in branch_order_detail even when it
 * spans several head_order_detail lots (different base prices and expiry
 * dates), so this is where the per-lot breakdown lives - it's what lets
 * reject/receive put the reserved stock back on exactly the lots it was taken
 * from. Written once when the lots are picked; never updated afterwards.
 */
export const branchOrderAllocation = pgTable(
  "branch_order_allocation",
  {
    bodId: integer("bod_id")
      .notNull()
      .references(() => branchOrderDetail.bodId),
    hodId: integer("hod_id")
      .notNull()
      .references(() => headOrderDetail.hodId),
    amount: integer("amount").notNull(),
    ...timestamps(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.bodId, table.hodId] }),
    amountPositive: check(
      "branch_order_allocation_amount_positive",
      sql`${table.amount} > 0`,
    ),
  }),
);
