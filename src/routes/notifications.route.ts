import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { NotificationModel } from "@/models/notification.model";
import { notificationService } from "@/services/notification.service";
import {
  successResponse,
  tErrorResponse,
  toActor,
  tSuccessResponse,
} from "@/utils";

// HQ and branch accounts can view alerts — cashier/customer never reach any
// handler below (authPlugin's macro 403s them first).
const alertResponse = {
  200: tSuccessResponse(NotificationModel.alertListResult),
  403: tErrorResponse("FORBIDDEN"),
  500: tErrorResponse("INTERNAL_SERVER_ERROR"),
};

export const notificationsRoute = new Elysia({ prefix: "/notifications" })
  .use(authPlugin)
  .get(
    "/hq/expire",
    async () =>
      successResponse({ result: await notificationService.listHqExpire() }),
    {
      auth: ["hq"],
      response: {
        200: tSuccessResponse(NotificationModel.alertListResult),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "List open HQ expire notifications",
        description:
          "Unresolved expire notifications scoped to HQ (branchId null), joined with product name/barcode. Opened by POST /notifications/scan.",
        tags: ["Notifications"],
      },
    },
  )
  .get(
    "/hq/min-stock",
    async () =>
      successResponse({ result: await notificationService.listHqMinStock() }),
    {
      auth: ["hq"],
      response: {
        200: tSuccessResponse(NotificationModel.alertListResult),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "List open HQ min_stock notifications",
        description:
          "Unresolved min_stock notifications scoped to HQ (branchId null), joined with product name/barcode. Opened/resolved by ordersBranchService.create() and by POST /notifications/scan.",
        tags: ["Notifications"],
      },
    },
  )
  .get(
    "/branches/:branchId/expire",
    async ({ user, params }) =>
      successResponse({
        result: await notificationService.listBranchExpire(
          toActor(user),
          params.branchId,
        ),
      }),
    {
      auth: ["hq", "branch"],
      params: NotificationModel.branchParams,
      response: alertResponse,
      detail: {
        summary: "List open expire notifications for a branch",
        description:
          "Unresolved expire notifications for one branch, joined with product name/barcode. hq can view any branch; a branch user only their own (403 otherwise). Opened by POST /notifications/scan.",
        tags: ["Notifications"],
      },
    },
  )
  .get(
    "/branches/:branchId/min-stock",
    async ({ user, params }) =>
      successResponse({
        result: await notificationService.listBranchMinStock(
          toActor(user),
          params.branchId,
        ),
      }),
    {
      auth: ["hq", "branch"],
      params: NotificationModel.branchParams,
      response: alertResponse,
      detail: {
        summary: "List open min_stock notifications for a branch",
        description:
          "Unresolved min_stock notifications for one branch, joined with product name/barcode. hq can view any branch; a branch user only their own (403 otherwise). Opened/resolved by ordersBranchService.create() and by POST /notifications/scan.",
        tags: ["Notifications"],
      },
    },
  )
  .post(
    "/scan",
    async () => successResponse(await notificationService.scanAlerts()),
    {
      auth: ["hq"],
      response: {
        200: tSuccessResponse(NotificationModel.scanResult),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Scan inventory for new HQ and branch alerts",
        description:
          "Recomputes every active product's HQ and branch min_stock alerts (opens if stock has dropped below its threshold, resolves once it's back above) and opens an expire alert for any HQ or branch lot landing inside the configured warning window. Meant to be triggered periodically (e.g. by an external cron hitting this endpoint) until a real scheduler is wired in.",
        tags: ["Notifications"],
      },
    },
  );
