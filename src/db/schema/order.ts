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
  "completed", // branch and customer
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
    // What HQ actually paid the supplier for this lot — not the product's
    // selling price, which is global (see product.price).
    costPrice: integer("cost_price").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lotId, table.hodId] }),
    // hodId is already unique on its own (serial), but the primary key is
    // composite - this keeps lookups that address a lot by hod_id alone (the
    // stock deduction's `where hod_id = ...`) unique and indexed.
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
    // What the customer actually paid per unit — product.price at the time
    // of sale, not the lot's cost.
    price: integer("unit_price").notNull().default(0),
    // Which branchOrderDetail lot this row was drawn from — lets cancel()
    // credit back the exact lot, not one picked fresh by a second FEFO pass.
    bodId: integer("bod_id")
      .notNull()
      .references(() => branchOrderDetail.bodId),
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
    // The lot's actual cost — copied from the HQ lot's costPrice once HQ
    // approves and fills this request (see orders-branch.service.ts).
    costPrice: integer("cost_price").notNull().default(0),
    // A snapshot of product.price taken when the branch requested this lot
    // — kept for historical display even if the global price changes later.
    price: integer("price").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lotId, table.bodId] }),
    // Same as head_order_detail: keeps bod_id unique and indexed on its own.
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
