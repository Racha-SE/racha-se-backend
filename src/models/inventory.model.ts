import { t } from "elysia";
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

export const InventoryModel = {
  branchParams: t.Object({ branchId: t.Numeric() }),
};
