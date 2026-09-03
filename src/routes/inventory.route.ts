import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { InventoryModel } from "@/models/inventory.model";
import { inventoryService } from "@/services/inventory.service";
import { successResponse, tErrorResponse, tSuccessResponse } from "@/utils";

const stubResponse = {
  200: tSuccessResponse(t.Object({ result: t.Null() })),
  500: tErrorResponse("INTERNAL_SERVER_ERROR"),
};

export const inventoryRoute = new Elysia({ prefix: "/inventory" })
  .use(authPlugin)
  .get(
    "/hq",
    async () =>
      successResponse({ result: await inventoryService.getHqStock() }),
    {
      auth: true, // change later
      response: stubResponse,
      detail: {
        summary: "View a branch's real-time stock (searchable)",
        description: "Current stock on hand for a headquarter",
        tags: ["Inventory"],
      },
    },
  )
  .get(
    "/branches/:branchId",
    async () =>
      successResponse({ result: await inventoryService.getBranchStock() }),
    {
      auth: true, // change later
      params: InventoryModel.branchParams,
      response: stubResponse,
      detail: {
        summary: "View a branch's real-time stock (searchable)",
        description:
          "Current stock on hand for a branch, searchable by product name or barcode/SKU.",
        tags: ["Inventory"],
      },
    },
  );
