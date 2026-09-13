import { t, Static } from "elysia";
import { tSuccessResponse, tErrorResponse } from "@/utils";

const productDetail = t.Object({
  pId: t.Number(),
  name: t.String(),
  barcode: t.String(),
});

// สำหรับ GET /hq (รวมสต็อกปกติ และ Low Stock ของ HQ)
export const hqStockResponse = {
  200: tSuccessResponse(
    t.Object({
      result: t.Array(
        t.Object({
          pId: t.Number(),
          productName: t.String(),
          barcode: t.String(),
          totalQuantity: t.Number(),
        }),
      ),
    }),
  ),
};

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

// 1. สำหรับ HQ Near Expiry (ไม่มี branchId)
export const hqNearExpiryResponse = {
  200: tSuccessResponse(
    t.Object({
      result: t.Array(
        t.Object({
          lotId: t.Number(),
          quantity: t.Number(),
          expiredDate: t.Union([t.Date(), t.String(), t.Null()]),
          product: productDetail,
        }),
      ),
    }),
  ),
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
const productSortOption = [
  "pId",
  "name",
  "categoryName",
  "quantity",
  "price",
  "expiredDate",
] as const;
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
    categoryName: t.String({ minLength: 1 }),
    limit: t.Numeric({ minimum: 1 }),
    offset: t.Numeric({ minimum: 0 }),
    sortOption: productSortOptionEnum,
    sortOrder: productSortOrderEnum,
  }),
);

const HqInventoryItem = t.Object({
  pId: t.String(),
  productName: t.String(),
  productCategory: t.Array(t.String()),
  quantity: t.Integer(),
  price: t.Numeric(),
  expiredDate: t.String({ format: "date-time" }),
});

// The route is a searchable, sortable, paged list — one item per product.
const HqInventoryResponse = t.Object({
  inventory: t.Array(HqInventoryItem),
});

export const InventoryModel = {
  getHqInventoryQuery: HqInventoryQuery,
  getHqInventoryResponse: HqInventoryResponse,

  branchParams: t.Object({ branchId: t.Numeric() }),
};

export type HqInventoryQuery = Static<typeof HqInventoryQuery>;
export type HqInventoryItem = Static<typeof HqInventoryItem>;
