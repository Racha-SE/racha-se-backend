import { sql } from "drizzle-orm";
import { check, integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { branch } from "./branch";
import { createdAtColumn } from "./helpers";
import { product } from "./product";
import { user } from "./user";

/**
 * A branch correcting its own stock so the system matches what's physically
 * on the shelf (US-5.4). One row per correction: `quantityChange` is signed
 * (+ found more, − damaged/lost/miscounted) and `reason` is mandatory, so
 * every manual change to branch stock carries who made it and why.
 *
 * The row is the record; the stock move itself lands on branch_order_detail
 * lots (see stockAdjustmentsService.create).
 */
export const stockAdjustment = pgTable(
  "stock_adjustment",
  {
    adjustmentId: serial("adjustment_id").primaryKey(),
    branchId: integer("branch_id")
      .notNull()
      .references(() => branch.branchId),
    pId: integer("p_id")
      .notNull()
      .references(() => product.pId),
    quantityChange: integer("quantity_change").notNull(),
    reason: text("reason").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    quantityChangeNonZero: check(
      "stock_adjustment_quantity_change_nonzero",
      sql`${table.quantityChange} <> 0`,
    ),
  }),
);
