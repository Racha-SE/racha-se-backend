import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import {
  InventoryModel,
  getBranchInventoryResponse,
} from "@/models/inventory.model";
import { inventoryService } from "@/services/inventory.service";
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
  );
