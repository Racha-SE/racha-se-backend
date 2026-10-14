import { t, Static } from "elysia";
import { ProductsModel } from "@/models/products.model";
import { tSuccessResponse, tErrorResponse } from "@/utils";

// `as const` keeps the literals out of the `string` widening — without it
// `Static<typeof productSortOptionEnum>` is just `string`, and the service
// can't use the value to index its sort-column map.
const productSortOption = ["quantity", "costPrice", "expiredDate"] as const;
const productSortOrder = ["asc", "desc"] as const;

const productSortOptionEnum = t.Union(
  productSortOption.map((option) => t.Literal(option)),
);

const productSortOrderEnum = t.Union(
  productSortOrder.map((option) => t.Literal(option)),
);

// `productCategory` predates `categories` and carries names only, so a client
// couldn't match it to a categoryId. Kept as-is so existing clients don't
// break; new code should read `categories`.
const productCategoryNames = t.Array(t.String(), {
  description: "Category names only — deprecated, use `categories`.",
});
const categories = t.Array(ProductsModel.categoryRef);

const HqInventoryQuery = t.Partial(
  t.Object({
    search: t.String({ minLength: 1 }),
    categoryId: t.Numeric({ minimum: 1 }),
    categoryName: t.String({ minLength: 1 }),
    limit: t.Numeric({ minimum: 1 }),
    offset: t.Numeric({ minimum: 0 }),
    sortOption: productSortOptionEnum,
    sortOrder: productSortOrderEnum,
    groupBy: t.Boolean({ default: false }),
  }),
);
const BranchInventoryQuery = t.Partial(
  t.Object({
    search: t.String({ minLength: 1 }),
    categoryId: t.Numeric({ minimum: 1 }),
    categoryName: t.String({ minLength: 1 }),
    limit: t.Numeric({ minimum: 1 }),
    offset: t.Numeric({ minimum: 0 }),
    sortOption: productSortOptionEnum,
    sortOrder: productSortOrderEnum,
    groupBy: t.Boolean({ default: false }),
  }),
);

// One item per on-hand head_order_detail lot, so a product with several lots
// appears once per lot. `price` is the product's global selling price
// (same on every row of the same product); `costPrice` is this specific
// lot's cost, which can differ lot to lot.
const HqInventoryItem = t.Object({
  pId: t.Number(),
  productName: t.String(),
  productCategory: productCategoryNames,
  categories,
  description: t.String(),
  barcode: t.String(),
  quantity: t.Integer(),
  price: t.Numeric(),
  costPrice: t.Numeric(),
  expiredDate: t.String({ format: "date-time" }),
});

// Grouped: the same lots rolled up under their product. `price` is the
// product's global selling price; each lot in `stocks` keeps its own
// `costPrice`, since cost can differ lot to lot even after grouping.
const HqInventoryGroupByProduct = t.Object({
  pId: t.Number(),
  productName: t.String(),
  productCategory: productCategoryNames,
  categories,
  description: t.String(),
  barcode: t.String(),
  price: t.Numeric(),
  stocks: t.Array(
    t.Object({
      quantity: t.Integer(),
      costPrice: t.Numeric(),
      expiredDate: t.String({ format: "date-time" }),
    }),
  ),
});

// The route is a searchable, sortable, paged list — grouped it pages over
// products, ungrouped over lots. `totalCount` counts whatever the current mode
// pages over, so it's a product count when grouped and a lot count when not.
const HqInventoryResponse = t.Object({
  inventory: t.Union([
    t.Array(HqInventoryItem),
    t.Array(HqInventoryGroupByProduct),
  ]),
  totalCount: t.Integer(),
});

// Branch's ungrouped mode: one item per on-hand branch_order_detail lot,
// same shape as HqInventoryItem (branchId is implicit from the route param,
// not repeated per row). `expiredDate` is nullable here only because the
// column briefly is before a branch order is approved — any row this reaches
// has remain > 0, which only happens after approval sets it, so in practice
// it's never actually null.
const BranchInventoryItem = t.Object({
  pId: t.Number(),
  productName: t.String(),
  productCategory: productCategoryNames,
  categories,
  description: t.String(),
  barcode: t.String(),
  quantity: t.Integer(),
  price: t.Numeric(),
  costPrice: t.Numeric(),
  expiredDate: t.Union([t.String({ format: "date-time" }), t.Null()]),
});

// Branch's grouped mode: every lot collapsed into the branch's single
// on-hand total for that product — what a cashier needs ("how many can I
// sell, and for how much"), not a lot-by-lot cost breakdown like the
// ungrouped mode carries (costPrice is deliberately omitted: the lots
// collapsed into this row can have different costs, so there's no single
// right value to report once they're summed).
const BranchInventoryGroupByProduct = t.Object({
  pId: t.Number(),
  productName: t.String(),
  productCategory: productCategoryNames,
  categories,
  description: t.String(),
  barcode: t.String(),
  quantity: t.Integer(),
  price: t.Numeric(),
});

const BranchInventoryResponse = t.Object({
  inventory: t.Union([
    t.Array(BranchInventoryItem),
    t.Array(BranchInventoryGroupByProduct),
  ]),
  totalCount: t.Integer(),
});

export const getBranchInventoryResponse = {
  200: tSuccessResponse(BranchInventoryResponse),
  403: tErrorResponse("FORBIDDEN"),
  404: tErrorResponse("NOT_FOUND"),
};

export const InventoryModel = {
  getHqInventoryQuery: HqInventoryQuery,
  getHqInventoryResponse: HqInventoryResponse,

  branchParams: t.Object({ branchId: t.Numeric() }),
  getBranchInventoryQuery: BranchInventoryQuery,
};

export type BranchInventoryQuery = Static<typeof BranchInventoryQuery>;
export type BranchInventoryItem = Static<typeof BranchInventoryItem>;
export type BranchInventoryGroupByProduct = Static<
  typeof BranchInventoryGroupByProduct
>;
export type BranchInventoryResult = Static<typeof BranchInventoryResponse>;
export type HqInventoryQuery = Static<typeof HqInventoryQuery>;
export type HqInventoryItem = Static<typeof HqInventoryItem>;
export type HqInventoryGroupByProduct = Static<
  typeof HqInventoryGroupByProduct
>;
export type HqInventoryResult = Static<typeof HqInventoryResponse>;
