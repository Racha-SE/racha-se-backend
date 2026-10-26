import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { AnalyticsModel } from "@/models/analytics.model";
import { analyticsService } from "@/services/analytics.service";
import {
  successResponse,
  tErrorResponse,
  toActor,
  tSuccessResponse,
} from "@/utils";

const sellerRankingResponse = {
  200: tSuccessResponse(AnalyticsModel.sellerRankingResponse),
  400: tErrorResponse("BAD_REQUEST"),
  404: tErrorResponse("NOT_FOUND"),
  500: tErrorResponse("INTERNAL_SERVER_ERROR"),
};

// Branch routes are scoped to the caller's own branch, so there's no unknown
// branch to 404 on — only an account without a branch to 403 on.
const branchErrorResponses = {
  400: tErrorResponse("BAD_REQUEST"),
  403: tErrorResponse("FORBIDDEN"),
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
  )
  .get(
    "/branch/best-sellers",
    async ({ user, query }) =>
      successResponse(
        await analyticsService.rankBranchSellers(toActor(user), query),
      ),
    {
      auth: ["branch"],
      query: AnalyticsModel.branchSellerRankingQuery,
      response: {
        200: tSuccessResponse(AnalyticsModel.sellerRankingResponse),
        ...branchErrorResponses,
      },
      detail: {
        summary:
          "Rank the caller's branch best-selling products for a date range",
        description:
          "Same ranking as /hq/best-sellers, but only ever counts sales made at the signed-in branch user's own branch — there's no `branchId` to pass.",
        tags: ["Analytics"],
      },
    },
  )
  .get(
    "/branch/dead-stock",
    async ({ user, query }) =>
      successResponse(
        await analyticsService.getDeadStock(toActor(user), query),
      ),
    {
      auth: ["branch"],
      query: AnalyticsModel.deadStockQuery,
      response: {
        200: tSuccessResponse(AnalyticsModel.deadStockResponse),
        ...branchErrorResponses,
      },
      detail: {
        summary: "List the caller's branch dead stock for a date range",
        description:
          "Active products the signed-in branch user's branch has on hand (unexpired stock from completed lots — the same stock /inventory/branches/:branchId lists) that had no completed customer-order sale there in `[from, to)`. Most units on hand first; `lastSoldAt` is the branch's latest sale of the product at any time (null if never). Paginated with `limit`/`offset`; `totalCount` covers every page.",
        tags: ["Analytics"],
      },
    },
  );
