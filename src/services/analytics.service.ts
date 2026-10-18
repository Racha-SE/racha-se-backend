import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  isNotNull,
  lt,
  sql,
} from "drizzle-orm";
import { db } from "@/db/client";
import {
  branch,
  customerOrderDetail,
  order,
  product,
  productCategoryMap,
} from "@/db/schema";
import type {
  SellerRankingQuery,
  SellerRankingResult,
  SellerSortBy,
} from "@/models/analytics.model";
import { categoriesFor } from "@/services/products.service";
import { AppError } from "@/utils";

const DEFAULT_LIMIT = 10;
const DEFAULT_SORT_BY: SellerSortBy = "revenue";
const DEFAULT_TIMEFRAME_MS = 30 * 24 * 60 * 60 * 1000;

/** Which end of the ranking a list is read from. */
export type SellerRankingDirection = "best" | "worst";

/**
 * The `[from, to)` window a ranking covers. Either bound may be left out:
 * `to` defaults to now, `from` to 30 days before `to`.
 */
function resolveTimeframe(query: SellerRankingQuery) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_TIMEFRAME_MS);

  if (from >= to) {
    throw new AppError("BAD_REQUEST", {
      message: "`from` must be earlier than `to`",
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }

  return { from, to };
}

export const analyticsService = {
  /**
   * Ranks active products by what they sold in a timeframe. A sale is a line
   * of a *completed* customer order — a pending QR order hasn't been paid
   * yet, and a cancelled one ends up rejected, so neither counts. Revenue is
   * quantity × the price stamped on each sale line, not today's
   * `product.price`.
   *
   * "best" lists only products that sold something, highest first. "worst"
   * starts from every active product, so the ones that sold nothing at all
   * rank lowest — that's the list HQ most needs to see.
   */
  async rankSellers(
    direction: SellerRankingDirection,
    query: SellerRankingQuery,
  ): Promise<SellerRankingResult> {
    const { from, to } = resolveTimeframe(query);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const sortBy = query.sortBy ?? DEFAULT_SORT_BY;

    // An unknown branch would otherwise come back as "every product sold
    // nothing", which reads like a real answer.
    if (query.branchId !== undefined) {
      const [found] = await db
        .select({ branchId: branch.branchId })
        .from(branch)
        .where(eq(branch.branchId, query.branchId));

      if (!found) {
        throw new AppError("NOT_FOUND", {
          message: "Branch not found",
          branchId: query.branchId,
        });
      }
    }

    // One row per product sold in the window. A cart line drawn from more
    // than one lot is stored as several rows, so the totals have to be sums
    // and the order count has to be distinct.
    const sales = db
      .select({
        pId: customerOrderDetail.pId,
        totalRevenue:
          sql<number>`sum(${customerOrderDetail.quantity}::bigint * ${customerOrderDetail.price})`.as(
            "total_revenue",
          ),
        totalQuantity: sql<number>`sum(${customerOrderDetail.quantity})`.as(
          "total_quantity",
        ),
        orderCount:
          sql<number>`count(distinct ${customerOrderDetail.lotId})`.as(
            "order_count",
          ),
      })
      .from(customerOrderDetail)
      .innerJoin(order, eq(order.lotId, customerOrderDetail.lotId))
      .where(
        and(
          eq(order.orderType, "customer"),
          eq(order.status, "completed"),
          gte(order.createdAt, from),
          lt(order.createdAt, to),
          query.branchId !== undefined
            ? eq(customerOrderDetail.branchId, query.branchId)
            : undefined,
        ),
      )
      .groupBy(customerOrderDetail.pId)
      .as("sales");

    // Left-joined, so a product with no sales has nulls here — read as 0.
    // The aggregates are bigint, which the driver hands back as strings.
    const totals = {
      revenue: sql<number>`coalesce(${sales.totalRevenue}, 0)`.mapWith(Number),
      quantity: sql<number>`coalesce(${sales.totalQuantity}, 0)`.mapWith(
        Number,
      ),
    };
    const orderCount = sql<number>`coalesce(${sales.orderCount}, 0)`.mapWith(
      Number,
    );

    // The chosen metric first, the other one to break ties, then pId so
    // products that tie on both still come back in a stable order.
    const tieBreakBy: SellerSortBy =
      sortBy === "revenue" ? "quantity" : "revenue";
    const sortDirection = direction === "best" ? desc : asc;

    const rows = await db
      .select({
        pId: product.pId,
        productName: product.name,
        barcode: product.barcode,
        totalRevenue: totals.revenue,
        totalQuantity: totals.quantity,
        orderCount,
      })
      .from(product)
      .leftJoin(sales, eq(sales.pId, product.pId))
      .where(
        and(
          eq(product.isActive, true),
          // best sellers have to have sold something; worst keeps the rest
          direction === "best" ? isNotNull(sales.pId) : undefined,
          query.categoryId !== undefined
            ? exists(
                db
                  .select({ pId: productCategoryMap.pId })
                  .from(productCategoryMap)
                  .where(
                    and(
                      eq(productCategoryMap.pId, product.pId),
                      eq(productCategoryMap.categoryId, query.categoryId),
                    ),
                  ),
              )
            : undefined,
        ),
      )
      .orderBy(
        sortDirection(totals[sortBy]),
        sortDirection(totals[tieBreakBy]),
        asc(product.pId),
      )
      .limit(limit);

    const categoriesByProduct = await categoriesFor(rows.map((row) => row.pId));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      sortBy,
      result: rows.map((row, index) => ({
        rank: index + 1,
        ...row,
        categories: categoriesByProduct.get(row.pId) ?? [],
      })),
    };
  },
};
