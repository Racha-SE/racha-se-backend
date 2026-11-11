import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import {
  InventoryModel,
  getBranchInventoryResponse,
} from "@/models/inventory.model";
import { StockAdjustmentsModel } from "@/models/stock-adjustments.model";
import { inventoryService } from "@/services/inventory.service";
import { stockAdjustmentsService } from "@/services/stock-adjustments.service";
import {
  successResponse,
  tErrorResponse,
  toActor,
  tSuccessResponse,
} from "@/utils";

export const inventoryRoute = new Elysia({ prefix: "/inventory" })
  .use(authPlugin)

  // --- ฝั่ง HQ ---
  .get(
    "/hq",
    async ({ user, query }) =>
      successResponse(await inventoryService.getHqStock(toActor(user), query)),
    {
      auth: ["hq"], // change later
      query: InventoryModel.getHqInventoryQuery,
      response: {
        200: tSuccessResponse(InventoryModel.getHqInventoryResponse),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "View a headquarter's real-time stock (searchable)",
        description:
          "Current stock on hand for a headquarter. `groupBy=false` " +
          "(default) lists lots; `groupBy=true` collapses them into one " +
          "row per product, with each lot's quantity/cost/expiry under " +
          "`stocks`.",
        tags: ["Inventory"],
      },
    },
  )

  // --- ฝั่ง Branch ---
  .get(
    "/branches/:branchId",
    async ({ params: { branchId }, query }) =>
      successResponse(await inventoryService.getBranchStock(branchId, query)),
    {
      auth: true,
      params: InventoryModel.branchParams,
      query: InventoryModel.getBranchInventoryQuery,
      response: getBranchInventoryResponse,
      detail: {
        summary: "View a branch's real-time stock (searchable)",
        description:
          "Same shape as GET /inventory/hq, scoped to one branch. " +
          "`groupBy=false` (default) lists lots; `groupBy=true` collapses " +
          "them into one on-hand total per product for a cashier.",
        tags: ["Inventory"],
      },
    },
  )
  .post(
    "/branches/:branchId/adjustments",
    async ({ user, params: { branchId }, body }) =>
      successResponse(
        await stockAdjustmentsService.create(toActor(user), branchId, body),
      ),
    {
      auth: ["branch"],
      params: StockAdjustmentsModel.params,
      body: StockAdjustmentsModel.createBody,
      response: {
        200: tSuccessResponse(StockAdjustmentsModel.createResponse),
        400: tErrorResponse("BAD_REQUEST"),
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        409: tErrorResponse("INSUFFICIENT_STOCK"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Adjust a branch's stock of one product",
        description:
          "Branch user corrects their own branch's stock so the system " +
          "matches the shelf. `quantityChange` is signed and non-zero; " +
          "`reason` is required. A negative change comes off on-hand lots " +
          "nearest-expiry first (409 INSUFFICIENT_STOCK if it's more than " +
          "is on hand); a positive change goes onto the newest unexpired " +
          "lot (400 if the branch never received the product). Each " +
          "adjustment is recorded with who made it and why, and the " +
          "branch's min_stock alert is re-checked. Returns the record plus " +
          "`onHand`, the product's new on-hand total at the branch.",
        tags: ["Inventory"],
      },
    },
  );
