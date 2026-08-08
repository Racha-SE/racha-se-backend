import { pgTable, serial, varchar } from "drizzle-orm/pg-core";
import { timestamps } from "./helpers";

export const supplier = pgTable("supplier", {
  supplierId: serial("supplier_id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  contact: varchar("contact", { length: 255 }).notNull(),
  ...timestamps(),
});
