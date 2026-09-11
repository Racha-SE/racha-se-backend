import { type Static, t } from "elysia";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { product } from "@/db/schema";

const entity = createSelectSchema(product);
const insertSchema = createInsertSchema(product);

const baseProductBody = t.Omit(insertSchema, ["pId", "createdAt", "updatedAt"]);

export const ProductsModel = {
  entity,
  params: t.Object({
    id: t.Numeric(),
  }),
  listQuery: t.Partial(t.Object({
    search: t.String(),
    categoryId: t.Numeric(),
    isActive: t.Boolean(),
    limit: t.Numeric(),
    offset: t.Numeric(),
  })),
  listResult: t.Object({
    products: t.Array(entity),
    total: t.Number(),
    page: t.Number(),
    totalPages: t.Number(),
    limit: t.Number(),
    offset: t.Number(),
  }),
  createBody: t.Composite([
    baseProductBody,
    t.Object({
      categoryIds: t.Optional(t.Array(t.Number())),
    }),
  ]),
  updateBody: t.Composite([
    t.Partial(baseProductBody),
    t.Object({
      categoryIds: t.Optional(t.Array(t.Number())),
    }),
  ]),
};

export type Product = Static<typeof ProductsModel.entity>;
export type ListProductsQuery = Static<typeof ProductsModel.listQuery>;
export type ListProductsResult = Static<typeof ProductsModel.listResult>;
export type CreateProductBody = Static<typeof ProductsModel.createBody>;
export type UpdateProductBody = Static<typeof ProductsModel.updateBody>;
