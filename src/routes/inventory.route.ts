import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { InventoryModel } from "@/models/inventory.model";
import { inventoryService } from "@/services/inventory.service";
import { successResponse, tSuccessResponse } from "@/utils";

const stubResponse = { 200: tSuccessResponse(t.Object({ result: t.Null() })) };

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
    "/hq/low-stock",
    async () =>
      successResponse({ result: await inventoryService.listHqLowStock() }),
    {
      auth: true, // change later
      response: stubResponse,
      detail: {
        summary: "List HQ products below minimum stock",
        description:
          "Live query, HQ scope only - no notification table. Branch/cashier scope is the separate low-stock route under US-3.3, not this one.",
        tags: ["Inventory"],
      },
    },
  )
  .get(
    "/hq/near-expiry",
    async () =>
      successResponse({ result: await inventoryService.listHqNearExpiry() }),
    {
      auth: true, // change later
      response: stubResponse,
      detail: {
        summary: "List HQ near-expiry items",
        description:
          "Live query, HQ scope only - no notification table. Branch/cashier scope is the separate near-expiry route under US-3.3, not this one.",
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
  )
  .get(
    "/branches/:branchId/low-stock",
    async () =>
      successResponse({
        result: await inventoryService.listBranchLowStock(),
      }),
    {
      auth: true, // change later
      params: InventoryModel.branchParams,
      response: stubResponse,
      detail: {
        summary: "List products below minimum stock",
        description:
          "Products whose remaining stock is under the branch's minStockBranch. Auth: hq, branch, and cashier (this is the branch/cashier counterpart to US-2.6's HQ-only route).",
        tags: ["Inventory"],
      },
    },
  )
  .get(
    "/branches/:branchId/near-expiry",
    async () =>
      successResponse({
        result: await inventoryService.listBranchNearExpiry(),
      }),
    {
      auth: true, // change later
      params: InventoryModel.branchParams,
      response: stubResponse,
      detail: {
        summary: "List near-expiry items",
        description:
          "Stock lots expiring within a configurable window (default 7 days). Auth: hq, branch, and cashier (this is the branch/cashier counterpart to US-2.6's HQ-only route).",
        tags: ["Inventory"],
      },
    },
  );
