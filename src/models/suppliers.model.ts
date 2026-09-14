import { type Static, t } from "elysia";
import { createSelectSchema } from "drizzle-typebox";
import { supplier } from "@/db/schema";

const entity = createSelectSchema(supplier);

export const SuppliersModel = {
  entity,
  params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
};

export type Supplier = Static<typeof SuppliersModel.entity>;
