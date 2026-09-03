import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { NotificationModel } from "@/models/notification.model";
import { notificationService } from "@/services/notification.service";
import { successResponse, tErrorResponse, tSuccessResponse } from "@/utils";

const stubResponse = {
  200: tSuccessResponse(t.Object({ result: t.Null() })),
  500: tErrorResponse("INTERNAL_SERVER_ERROR"),
};

export const notificationsRoute = new Elysia({ prefix: "/notifications" })
  .use(authPlugin)
  .get(
    "/hq/expire",
    async () =>
      successResponse({ result: await notificationService.listHqExpire() }),
    {
      auth: true, // change later
      response: stubResponse,
      detail: {
        summary: "List open HQ expire notifications",
        description:
          "Unresolved expire notifications scoped to HQ (branchId null). See notification.service.ts for which order-flow actions are meant to create/resolve these — not wired in yet.",
        tags: ["Notifications"],
      },
    },
  )
  .get(
    "/hq/min-stock",
    async () =>
      successResponse({ result: await notificationService.listHqMinStock() }),
    {
      auth: true, // change later
      response: stubResponse,
      detail: {
        summary: "List open HQ min_stock notifications",
        description:
          "Unresolved min_stock notifications scoped to HQ (branchId null). See notification.service.ts for which order-flow actions are meant to create/resolve these — not wired in yet.",
        tags: ["Notifications"],
      },
    },
  )
  .get(
    "/branches/:branchId/expire",
    async () =>
      successResponse({
        result: await notificationService.listBranchExpire(),
      }),
    {
      auth: true, // change later
      params: NotificationModel.branchParams,
      response: stubResponse,
      detail: {
        summary: "List open expire notifications for a branch",
        description:
          "Unresolved expire notifications scoped to one branch. See notification.service.ts for which order-flow actions are meant to create/resolve these — not wired in yet.",
        tags: ["Notifications"],
      },
    },
  )
  .get(
    "/branches/:branchId/min-stock",
    async () =>
      successResponse({
        result: await notificationService.listBranchMinStock(),
      }),
    {
      auth: true, // change later
      params: NotificationModel.branchParams,
      response: stubResponse,
      detail: {
        summary: "List open min_stock notifications for a branch",
        description:
          "Unresolved min_stock notifications scoped to one branch. See notification.service.ts for which order-flow actions are meant to create/resolve these — not wired in yet.",
        tags: ["Notifications"],
      },
    },
  );
