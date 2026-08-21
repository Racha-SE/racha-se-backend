import { boolean, pgTable, serial, varchar } from "drizzle-orm/pg-core";
import { timestamps } from "./helpers";

export const branch = pgTable("branch", {
  branchId: serial("branch_id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  address: varchar("address", { length: 255 }).notNull(),
  phoneNumber: varchar("phone_number", { length: 255 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps(),
});
