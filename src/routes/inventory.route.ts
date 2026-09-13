import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import {
  InventoryModel,
  branchStockResponse,
  branchNearExpiryResponse,
} from "@/models/inventory.model";
import { inventoryService } from "@/services/inventory.service";
import {
  successResponse,
  tErrorResponse,
  toActor,
  tSuccessResponse,
} from "@/utils";

const stubResponse = {
  200: tSuccessResponse(t.Object({ result: t.Null() })),
  500: tErrorResponse("INTERNAL_SERVER_ERROR"),
};

export const inventoryRoute = new Elysia({ prefix: "/inventory" })
  .use(authPlugin)

  // --- ฝั่ง HQ ---
  .get(
    "/hq",
    async ({ user, query }) =>
      successResponse({
        result: await inventoryService.getHqStock(toActor(user), query),
      }),
    {
      auth: ["hq"], // change later
      query: InventoryModel.getHqInventoryQuery,
      response: stubResponse,
      detail: {
        summary: "View a headquarter's real-time stock (searchable)",
        description: "Current stock on hand for a headquarter",
        tags: ["Inventory"],
      },
    },
  )

  // --- ฝั่ง Branch ---
  .get(
    "/branches/:branchId",
    async ({ params: { branchId } }) =>
      successResponse({
        result: await inventoryService.getBranchStock(branchId),
      }),
    {
      auth: true,
      params: InventoryModel.branchParams,
      response: branchStockResponse,
      detail: {
        summary: "View a branch's real-time stock",
        tags: ["Inventory"],
      },
    },
  )
  .get(
    "/branches/:branchId/low-stock",
    async ({ params: { branchId } }) =>
      successResponse({
        result: await inventoryService.listBranchLowStock(branchId),
      }),
    {
      auth: true,
      params: InventoryModel.branchParams,
      response: branchStockResponse,
      detail: {
        summary: "List branch products below minimum stock",
        tags: ["Inventory"],
      },
    },
  )
  .get(
    "/branches/:branchId/near-expiry",
    async ({ params: { branchId } }) =>
      successResponse({
        result: await inventoryService.listBranchNearExpiry(branchId),
      }),
    {
      auth: true,
      params: InventoryModel.branchParams,
      response: branchNearExpiryResponse, //ใช้ nearExpiryResponse
      detail: { summary: "List branch near-expiry items", tags: ["Inventory"] },
    },
  );
