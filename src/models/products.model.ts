import { type Static, t } from "elysia";
import type { TString } from "@sinclair/typebox";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { product } from "@/db/schema";
import { AppError } from "@/utils/error";

const entity = createSelectSchema(product);

/** Trims a string field and rejects it if that leaves it empty. */
function trimmedNonEmpty(schema: TString, reason: string) {
  return t
    .Transform(schema)
    .Decode((value: string) => {
      const trimmed = value.trim();
      if (!trimmed) throw new AppError("VALIDATION", { reason });
      return trimmed;
    })
    .Encode((value: string) => value);
}

const insertSchema = createInsertSchema(product, {
  name: (schema) =>
    trimmedNonEmpty(schema, "Product name cannot be empty or whitespace"),
  barcode: (schema) => trimmedNonEmpty(schema, "Barcode cannot be empty"),
  description: (schema) =>
    t
      .Transform(schema)
      .Decode((value: string) => value.trim())
      .Encode((value: string) => value),
  minStockHq: t.Integer({ minimum: 0 }),
  minStockBranch: t.Integer({ minimum: 0 }),
  costPrice: t.Integer({ minimum: 0 }),
});

const baseProductBody = t.Omit(insertSchema, ["pId", "createdAt", "updatedAt"]);

export const ProductsModel = {
  entity,
  params: t.Object({
    id: t.Numeric({ minimum: 1 }),
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
