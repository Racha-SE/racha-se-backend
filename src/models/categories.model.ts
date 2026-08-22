import { type Static, t } from "elysia";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { productCategory } from "@/db/schema";

const entity = createSelectSchema(productCategory);
const insertSchema = createInsertSchema(productCategory);
const body = t.Omit(insertSchema, ["categoryId", "createdAt", "updatedAt"]);

export const CategoriesModel = {
  entity,
  params: t.Object({ id: t.Numeric() }),
  createBody: body,
  updateBody: t.Partial(body),
};

export type Category = Static<typeof CategoriesModel.entity>;
export type CreateCategoryBody = Static<typeof CategoriesModel.createBody>;
export type UpdateCategoryBody = Static<typeof CategoriesModel.updateBody>;
