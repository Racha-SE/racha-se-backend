import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import {
  InventoryModel,
  hqStockResponse,
  branchStockResponse,
  hqNearExpiryResponse,
  branchNearExpiryResponse,
} from "@/models/inventory.model";
import { inventoryService } from "@/services/inventory.service";
import { successResponse } from "@/utils";

export const inventoryRoute = new Elysia({ prefix: "/inventory" })
  .use(authPlugin)

  // --- ฝั่ง HQ ---
  .get(
    "/hq",
    async () =>
      successResponse({ result: await inventoryService.getHqStock() }),
    {
      auth: true,
      response: hqStockResponse,
      detail: { summary: "View HQ real-time stock", tags: ["Inventory"] },
    },
  )
  .get(
    "/hq/low-stock",
    async () =>
      successResponse({ result: await inventoryService.listHqLowStock() }),
    {
      auth: true,
      response: hqStockResponse,
      detail: {
        summary: "List HQ products below minimum stock",
        tags: ["Inventory"],
      },
    },
  )
  .get(
    "/hq/near-expiry",
    async () =>
      successResponse({ result: await inventoryService.listHqNearExpiry() }),
    {
      auth: true,
      response: hqNearExpiryResponse,
      detail: { summary: "List HQ near-expiry items", tags: ["Inventory"] },
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
