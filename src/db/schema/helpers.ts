import { timestamp } from "drizzle-orm/pg-core";

// Column builders attach themselves to a single table internally, so these
// must be functions returning a fresh builder per call — sharing one builder
// instance across multiple pgTable() calls corrupts both tables.
export const createdAtColumn = () =>
  timestamp("created_at").notNull().defaultNow();

export const updatedAtColumn = () =>
  timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const timestamps = () => ({
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});
