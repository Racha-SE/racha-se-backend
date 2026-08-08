import {
  check,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
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
  "completed",
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
    unitCost: integer("unit_cost").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lotId, table.hodId] }),
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
    unitPrice: integer("unit_price").notNull().default(0),
    unitCost: integer("unit_cost").notNull().default(0),
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
    ...timestamps(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lotId, table.bodId] }),
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
