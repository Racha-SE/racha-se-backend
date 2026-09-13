import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { OrdersHqModel } from "@/models/orders-hq.model";
import { ordersHqService } from "@/services/orders-hq.service";
import { successResponse, tErrorResponse, tSuccessResponse } from "@/utils";

export const ordersHqRoute = new Elysia({ prefix: "/orders/hq" })
  .use(authPlugin)
  .post(
    "/",
    async ({ user, body, status }) =>
      status(201, successResponse(await ordersHqService.create(user.id, body))),
    {
      auth: ["hq"],
      body: OrdersHqModel.createBody,
      response: {
        201: tSuccessResponse(OrdersHqModel.createBodyResponse),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Add a new HQ order",
        description:
          "HQ Admin adds a supplier order with line items directly into HQ warehouse stock - no approval step, since the same hq userType would both create and approve it; stock is available immediately.",
        tags: ["Orders HQ"],
      },
    },
  );
