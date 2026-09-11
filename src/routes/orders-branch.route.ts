import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { OrdersBranchModel } from "@/models/orders-branch.model";
import { ordersBranchService } from "@/services/orders-branch.service";
import {
  AppError,
  successResponse,
  tErrorResponse,
  tSuccessResponse,
} from "@/utils";

const stubResponse = {
  200: tSuccessResponse(t.Object({ result: t.Null() })),
  500: tErrorResponse("INTERNAL_SERVER_ERROR"),
};

export const ordersBranchRoute = new Elysia({ prefix: "/orders/branch" })
  .use(authPlugin)
  .get(
    "/",
    async ({ user, query }) => {
      const { userType, branchId } = user;

      return successResponse(
        await ordersBranchService.list(userType, query, branchId ?? undefined),
      );
    },
    {
      auth: ["hq", "branch"], // change later
      query: OrdersBranchModel.getBranchOrdersQuery,
      response: {
        200: tSuccessResponse(OrdersBranchModel.getBranchOrders),
        400: tErrorResponse("BAD_REQUEST"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "List branch orders",
        description:
          "List stock transfer orders sent to a branch, newest first. HQ sees every branch and can narrow with ?branchId; a branch caller is always scoped to its own branch, whatever it passes. Paginated with ?limit (default 10) and ?offset; `totals` is the unpaginated match count.",
        tags: ["Orders Branch"],
      },
    },
  )
  .get(
    "/:lotId",
    async ({ user, params }) => {
      const { userType, id } = user;

      return successResponse(
        await ordersBranchService.getById(params.lotId, userType, id),
      );
    },
    {
      auth: ["hq", "branch"], // change later
      params: OrdersBranchModel.params,
      response: {
        200: tSuccessResponse(OrdersBranchModel.getBranchOrderByLotId),
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Get one branch order",
        description:
          "View one branch order's requested line items (branch's own request, not yet a confirmed shipment) before it's approved and received. Includes per-item requested-vs-available HQ stock, so HQ can review fulfillability before approving.",
        tags: ["Orders Branch"],
      },
    },
  )
  .post(
    "/",
    async ({ user, body }) => {
      const { id, branchId } = user;

      if (!branchId) {
        throw new AppError("BAD_REQUEST", {
          message: "Branch ID is required for creating an order.",
        });
      }

      const createdOrderResult = await ordersBranchService.create(
        id,
        branchId,
        body,
      );

      return successResponse(createdOrderResult);
    },
    {
      auth: ["branch"],
      body: OrdersBranchModel.createBody,
      response: {
        200: tSuccessResponse(OrdersBranchModel.createResponse),
        400: tErrorResponse("BAD_REQUEST"),
        404: tErrorResponse("NOT_FOUND"),
        409: tErrorResponse("INSUFFICIENT_STOCK"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Request a stock transfer from HQ",
        description:
          "Branch requests stock from HQ - same actor pattern as US-2.1's HQ-creates-its-own-supplier-order (the receiving party creates the order, not the sender).",
        tags: ["Orders Branch"],
      },
    },
  )
  .patch(
    "/:lotId/approve",
    async () =>
      successResponse({ result: await ordersBranchService.approve() }),
    {
      auth: ["hq"], // change later
      params: OrdersBranchModel.params,
      response: {
        ...stubResponse,
        409: tErrorResponse("INSUFFICIENT_STOCK"),
      },
      detail: {
        summary: "Approve a branch order",
        description:
          "HQ approves a branch's pending request, fulfilling it - same actor relationship as US-2.1's HQ-approves-its-own-supplier-order. Without this step, a branch could request and self-confirm receipt with no HQ involvement at all. Rejects with INSUFFICIENT_STOCK if HQ can no longer cover the requested amount for any line item at approval time.",
        tags: ["Orders Branch"],
      },
    },
  )
  .patch(
    "/:lotId/reject",
    async () => successResponse({ result: await ordersBranchService.reject() }),
    {
      auth: ["hq"], // change later
      params: OrdersBranchModel.params,
      response: stubResponse,
      detail: {
        summary: "Reject a branch order",
        description: "HQ rejects a branch's pending request.",
        tags: ["Orders Branch"],
      },
    },
  )
  .post(
    "/:lotId/receive",
    async () =>
      successResponse({ result: await ordersBranchService.receive() }),
    {
      auth: ["branch"], // change later
      params: OrdersBranchModel.params,
      response: stubResponse,
      detail: {
        summary: "Record stock received at a branch",
        description:
          "Branch confirms receipt of an approved order; no body needed - the service deducts the approved amount from the linked headOrderDetail lot(s) and copies quantity/expiry/price into branchOrderDetail, branch stock increments immediately.",
        tags: ["Orders Branch"],
      },
    },
  );
