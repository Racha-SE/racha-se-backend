import { type Static, t } from "elysia";
import type { TString } from "@sinclair/typebox";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { product } from "@/db/schema";
import { AppError } from "@/utils/error";

const row = createSelectSchema(product);

// A product's link to one of its categories — the id (for filters and
// PATCH categoryIds) and the name (for display) together, so a client never
// has to join /categories itself. Shared with the inventory responses.
const categoryRef = t.Object({
  categoryId: t.Integer(),
  categoryName: t.String(),
});

// What every /products endpoint returns: the product row plus its
// categories, sorted by name (an empty array when it has none).
const entity = t.Composite([
  row,
  t.Object({ categories: t.Array(categoryRef) }),
]);

const categoryIds = t.Optional(
  t.Array(t.Integer({ minimum: 1 }), {
    description:
      "Replaces the product's categories. Duplicates are ignored; [] removes them all.",
  }),
);

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
  categoryRef,
  entity,
  params: t.Object({
    id: t.Numeric({ minimum: 1 }),
  }),
  listQuery: t.Partial(
    t.Object({
      search: t.String(),
      categoryId: t.Numeric({ minimum: 1 }),
      isActive: t.Boolean(),
      limit: t.Numeric(),
      offset: t.Numeric(),
    }),
  ),
  listResult: t.Object({
    products: t.Array(entity),
    total: t.Number(),
    page: t.Number(),
    totalPages: t.Number(),
    limit: t.Number(),
    offset: t.Number(),
  }),
  createBody: t.Composite([baseProductBody, t.Object({ categoryIds })]),
  updateBody: t.Composite([
    t.Partial(baseProductBody),
    t.Object({ categoryIds }),
  ]),
};

/** A bare `product` table row, before its categories are attached. */
export type ProductRow = Static<typeof row>;
export type ProductCategoryRef = Static<typeof categoryRef>;
export type Product = Static<typeof ProductsModel.entity>;
export type ListProductsQuery = Static<typeof ProductsModel.listQuery>;
export type ListProductsResult = Static<typeof ProductsModel.listResult>;
export type CreateProductBody = Static<typeof ProductsModel.createBody>;
export type UpdateProductBody = Static<typeof ProductsModel.updateBody>;
