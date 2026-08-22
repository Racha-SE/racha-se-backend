import { type Static, t } from "elysia";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { product } from "@/db/schema";

const entity = createSelectSchema(product);
const insertSchema = createInsertSchema(product);
const body = t.Omit(insertSchema, ["pId", "createdAt", "updatedAt"]);

export const ProductsModel = {
  entity,
  params: t.Object({ id: t.Numeric() }),
  categoryParams: t.Object({ id: t.Numeric(), categoryId: t.Numeric() }),
  createBody: body,
  updateBody: t.Partial(body),
  attachCategoriesBody: t.Object({
    categoryIds: t.Array(t.Number(), { minItems: 1 }),
  }),
};

export type Product = Static<typeof ProductsModel.entity>;
export type CreateProductBody = Static<typeof ProductsModel.createBody>;
export type UpdateProductBody = Static<typeof ProductsModel.updateBody>;
