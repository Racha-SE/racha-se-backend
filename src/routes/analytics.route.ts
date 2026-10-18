import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { AnalyticsModel } from "@/models/analytics.model";
import { analyticsService } from "@/services/analytics.service";
import { successResponse, tErrorResponse, tSuccessResponse } from "@/utils";

const sellerRankingResponse = {
  200: tSuccessResponse(AnalyticsModel.sellerRankingResponse),
  400: tErrorResponse("BAD_REQUEST"),
  404: tErrorResponse("NOT_FOUND"),
  500: tErrorResponse("INTERNAL_SERVER_ERROR"),
};

export const analyticsRoute = new Elysia({ prefix: "/analytics" })
  .use(authPlugin)
  .get(
    "/hq/best-sellers",
    async ({ query }) =>
      successResponse(await analyticsService.rankSellers("best", query)),
    {
      auth: ["hq"],
      query: AnalyticsModel.sellerRankingQuery,
      response: sellerRankingResponse,
      detail: {
        summary: "Rank HQ best-selling products for a timeframe",
        description:
          "Active products ranked by completed customer-order sales in `[from, to)`, highest first — by revenue (quantity × the price each line sold at) unless `sortBy=quantity`. Only products that sold something are listed. `branchId` narrows to one branch's sales (404 if it doesn't exist), `categoryId` to one category's products.",
        tags: ["Analytics"],
      },
    },
  )
  .get(
    "/hq/worst-sellers",
    async ({ query }) =>
      successResponse(await analyticsService.rankSellers("worst", query)),
    {
      auth: ["hq"],
      query: AnalyticsModel.sellerRankingQuery,
      response: sellerRankingResponse,
      detail: {
        summary: "Rank HQ worst-selling products for a timeframe",
        description:
          "Active products ranked by completed customer-order sales in `[from, to)`, lowest first — by revenue unless `sortBy=quantity`. Products with no sales at all are included (with zero totals) and rank lowest. Same filters as /hq/best-sellers.",
        tags: ["Analytics"],
      },
    },
  );
