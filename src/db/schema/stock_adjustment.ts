import { integer, pgEnum, pgTable, serial, text } from "drizzle-orm/pg-core";
import { branch } from "./branch";
import { createdAtColumn } from "./helpers";
import { product } from "./product";
import { user } from "./user";

export const adjustmentTypeEnum = pgEnum("adjustment_type", [
  "damaged",
  "lost",
  "count_error",
  "other",
]);

export const stockAdjustment = pgTable("stock_adjustment", {
  adjustmentId: serial("adjustment_id").primaryKey(),
  branchId: integer("branch_id")
    .notNull()
    .references(() => branch.branchId),
  pId: integer("p_id")
    .notNull()
    .references(() => product.pId),
  adjustmentType: adjustmentTypeEnum("adjustment_type").notNull(),
  quantityChange: integer("quantity_change").notNull(),
  reason: text("reason").notNull(),
  userId: integer("user_id")
    .notNull()
    .references(() => user.userId),
  createdAt: createdAtColumn(),
});
