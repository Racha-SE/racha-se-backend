import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { OrdersCustomerModel } from "@/models/orders-customer.model";
import { ordersCustomerService } from "@/services/orders-customer.service";
import {
  AppError,
  successResponse,
  tErrorResponse,
  tSuccessResponse,
} from "@/utils";

export const ordersCustomerRoute = new Elysia({ prefix: "/orders/customer" })
  .use(authPlugin)
  .get(
    "/",
    async ({ user, query }) => {
      const { branchId } = user;

      if (!branchId) {
        throw new AppError("BAD_REQUEST", {
          message: "Branch ID is required for listing customer orders.",
        });
      }

      return successResponse(await ordersCustomerService.list(query, branchId));
    },
    {
      auth: ["branch", "cashier"],
      query: OrdersCustomerModel.getCustomerOrdersQuery,
      response: {
        200: tSuccessResponse(OrdersCustomerModel.getCustomerOrders),
        400: tErrorResponse("BAD_REQUEST"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "List customer orders (POS sales)",
        description:
          "List checkout orders rung up at a branch, newest first. Always scoped to the caller's own branch - no hq-wide view. Paginated with ?limit (default 10) and ?offset; `totals` is the unpaginated match count.",
        tags: ["Orders Customer"],
      },
    },
  )
  .get(
    "/:lotId",
    async ({ user, params }) => {
      const { branchId } = user;

      if (!branchId) {
        throw new AppError("BAD_REQUEST", {
          message: "Branch ID is required for reading a customer order.",
        });
      }

      return successResponse(
        await ordersCustomerService.getById(params.lotId, branchId),
      );
    },
    {
      auth: ["branch", "cashier"],
      params: OrdersCustomerModel.params,
      response: {
        200: tSuccessResponse(OrdersCustomerModel.getCustomerOrderByLotId),
        400: tErrorResponse("BAD_REQUEST"),
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Get one customer order",
        description:
          "View one POS checkout's line items and status - only for the caller's own branch (FORBIDDEN otherwise). Stock is reserved for real at create time for both payment methods, so a pending row's items already reflect the real lot(s) drawn - not a placeholder quote.",
        tags: ["Orders Customer"],
      },
    },
  )
  .post(
    "/",
    async ({ user, body }) => {
      const { id, branchId } = user;

      if (!branchId) {
        throw new AppError("BAD_REQUEST", {
          message: "Branch ID is required for creating a customer order.",
        });
      }

      return successResponse(
        await ordersCustomerService.create(id, branchId, body),
      );
    },
    {
      auth: ["cashier"],
      body: OrdersCustomerModel.createBody,
      response: {
        200: tSuccessResponse(OrdersCustomerModel.createResponse),
        400: tErrorResponse("BAD_REQUEST"),
        404: tErrorResponse("NOT_FOUND"),
        409: tErrorResponse("INSUFFICIENT_STOCK"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Ring up a POS checkout",
        description:
          'Cashier checks a customer out at their own branch, against the branch\'s own on-hand stock (FEFO, nearest-expiry lot first) - not HQ\'s. Stock is locked and drawn for real in this same call for both payment methods: paymentMethod "cash" completes the order immediately; paymentMethod "qr" leaves it pending and returns a paymentUrl, but the units are already reserved - INSUFFICIENT_STOCK here means nothing was created at all, and a later confirm-payment can never fail on stock because of it.',
        tags: ["Orders Customer"],
      },
    },
  )
  .patch(
    "/:lotId/confirm-payment",
    async ({ params }) =>
      successResponse(await ordersCustomerService.confirmPayment(params.lotId)),
    {
      // No `auth` key on purpose — the one public route in this API.
      params: OrdersCustomerModel.params,
      response: {
        200: tSuccessResponse(OrdersCustomerModel.confirmPaymentResponse),
        400: tErrorResponse("BAD_REQUEST"),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Confirm a qr checkout's payment (mock, no auth)",
        description:
          'Only transitions a pending orderType:"customer" order to completed - no stock check happens here, create() already reserved the units for real. An already-completed order (paid twice, or a cash order\'s lotId) is rejected with BAD_REQUEST; a cancelled order is rejected the same way.',
        tags: ["Orders Customer"],
      },
    },
  )
  .patch(
    "/:lotId/cancel",
    async ({ user, params }) => {
      const { branchId } = user;

      if (!branchId) {
        throw new AppError("BAD_REQUEST", {
          message: "Branch ID is required for cancelling a customer order.",
        });
      }

      return successResponse(
        await ordersCustomerService.cancel(params.lotId, branchId),
      );
    },
    {
      auth: ["cashier"],
      params: OrdersCustomerModel.params,
      response: {
        200: tSuccessResponse(OrdersCustomerModel.cancelResponse),
        400: tErrorResponse("BAD_REQUEST"),
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Cancel a pending qr checkout",
        description:
          "The saga's compensating step: a cashier gives up on a customer who never paid, and gets the exact reserved units credited back to the exact lot(s) they came from - not a fresh FEFO pass. Only a cashier at the order's own branch can cancel it (FORBIDDEN otherwise); only a pending order can be cancelled (a completed or already-cancelled order is BAD_REQUEST).",
        tags: ["Orders Customer"],
      },
    },
  );
