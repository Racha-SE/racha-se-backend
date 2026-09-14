import { t, Static } from "elysia";
import { ProductsModel } from "@/models/products.model";
import { tSuccessResponse, tErrorResponse } from "@/utils";

const productDetail = t.Object({
  pId: t.Number(),
  name: t.String(),
  barcode: t.String(),
});

// สำหรับ GET /branches/:branchId (สต็อกปกติ และ Low Stock ของ Branch)
export const branchStockResponse = {
  200: tSuccessResponse(
    t.Object({
      result: t.Array(
        t.Object({
          branchId: t.Number(),
          quantity: t.Number(),
          product: productDetail,
        }),
      ),
    }),
  ),
  403: tErrorResponse("FORBIDDEN"),
  404: tErrorResponse("NOT_FOUND"),
};

// 2. สำหรับ Branch Near Expiry (มี branchId ด้วย)
export const branchNearExpiryResponse = {
  200: tSuccessResponse(
    t.Object({
      result: t.Array(
        t.Object({
          branchId: t.Number(),
          lotId: t.Number(),
          quantity: t.Number(),
          expiredDate: t.Union([t.Date(), t.String(), t.Null()]),
          product: productDetail,
        }),
      ),
    }),
  ),
  403: tErrorResponse("FORBIDDEN"),
  404: tErrorResponse("NOT_FOUND"),
};

// `as const` keeps the literals out of the `string` widening — without it
// `Static<typeof productSortOptionEnum>` is just `string`, and the service
// can't use the value to index its sort-column map.
const productSortOption = ["quantity", "price", "expiredDate"] as const;
const productSortOrder = ["asc", "desc"] as const;

const productSortOptionEnum = t.Union(
  productSortOption.map((option) => t.Literal(option)),
);

const productSortOrderEnum = t.Union(
  productSortOrder.map((option) => t.Literal(option)),
);

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

// `productCategory` predates `categories` and carries names only, so a client
// couldn't match it to a categoryId. Kept as-is so existing clients don't
// break; new code should read `categories`.
const productCategoryNames = t.Array(t.String(), {
  description: "Category names only — deprecated, use `categories`.",
});
const categories = t.Array(ProductsModel.categoryRef);

// Ungrouped: one item per head_order_detail lot, so a product with several
// lots on hand appears once per lot.
const HqInventoryItem = t.Object({
  pId: t.Number(),
  productName: t.String(),
  productCategory: productCategoryNames,
  categories,
  description: t.String(),
  barcode: t.String(),
  quantity: t.Integer(),
  price: t.Numeric(),
  expiredDate: t.String({ format: "date-time" }),
});

// Grouped: the same lots rolled up under their product.
const HqInventoryGroupByProduct = t.Object({
  pId: t.Number(),
  productName: t.String(),
  productCategory: productCategoryNames,
  categories,
  description: t.String(),
  barcode: t.String(),
  stocks: t.Array(
    t.Object({
      quantity: t.Integer(),
      price: t.Numeric(),
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

export const InventoryModel = {
  getHqInventoryQuery: HqInventoryQuery,
  getHqInventoryResponse: HqInventoryResponse,

  branchParams: t.Object({ branchId: t.Numeric() }),
};

export type HqInventoryQuery = Static<typeof HqInventoryQuery>;
export type HqInventoryItem = Static<typeof HqInventoryItem>;
export type HqInventoryGroupByProduct = Static<
  typeof HqInventoryGroupByProduct
>;
export type HqInventoryResult = Static<typeof HqInventoryResponse>;
