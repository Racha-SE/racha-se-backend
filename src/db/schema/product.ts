import {
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAtColumn, timestamps } from "./helpers";

export const product = pgTable("product", {
  pId: serial("p_id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  barcode: varchar("barcode", { length: 255 }).notNull(),
  basePrice: integer("base_price").notNull(),
  costPrice: integer("cost_price").notNull().default(0),
  minStockHq: integer("min_stock_hq").notNull().default(0),
  minStockBranch: integer("min_stock_branch").notNull().default(0),
  ...timestamps(),
});

export const productCategory = pgTable("product_category", {
  categoryId: serial("category_id").primaryKey(),
  categoryName: varchar("category_name", { length: 255 }).notNull(),
  ...timestamps(),
});

export const productCategoryMap = pgTable(
  "product_category_map",
  {
    pId: integer("p_id")
      .notNull()
      .references(() => product.pId),
    categoryId: integer("category_id")
      .notNull()
      .references(() => productCategory.categoryId),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pId, table.categoryId] }),
  }),
);
