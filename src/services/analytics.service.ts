import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  isNotNull,
  lt,
  max,
  notExists,
  sql,
} from "drizzle-orm";
import { db } from "@/db/client";
import {
  branch,
  branchOrderDetail,
  customerOrderDetail,
  order,
  product,
  productCategoryMap,
} from "@/db/schema";
import type {
  BranchSellerRankingQuery,
  DeadStockQuery,
  DeadStockResult,
  SellerRankingQuery,
  SellerRankingResult,
  SellerSortBy,
} from "@/models/analytics.model";
import { branchOnHandLots } from "@/services/inventory.service";
import { categoriesFor } from "@/services/products.service";
import { AppError, type ScopedActor } from "@/utils";

const DEFAULT_LIMIT = 10;
const DEFAULT_DEAD_STOCK_LIMIT = 20;
const DEFAULT_SORT_BY: SellerSortBy = "revenue";
const DEFAULT_TIMEFRAME_MS = 30 * 24 * 60 * 60 * 1000;

/** Which end of the ranking a list is read from. */
export type SellerRankingDirection = "best" | "worst";

/**
 * The `[from, to)` window a ranking covers. Either bound may be left out:
 * `to` defaults to now, `from` to 30 days before `to`.
 */
function resolveTimeframe(query: { from?: string; to?: string }) {
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

/**
 * The orders analytics counts as a sale: *completed* customer orders — a
 * pending QR order hasn't been paid yet, and a cancelled one ends up
 * rejected. Bounded to `[from, to)` when a window is given.
 */
function completedSale(window?: { from: Date; to: Date }) {
  return and(
    eq(order.orderType, "customer"),
    eq(order.status, "completed"),
    window ? gte(order.createdAt, window.from) : undefined,
    window ? lt(order.createdAt, window.to) : undefined,
  );
}

/** Keeps only products linked to `categoryId`, when one is given. */
function inCategory(categoryId?: number) {
  return categoryId !== undefined
    ? exists(
        db
          .select({ pId: productCategoryMap.pId })
          .from(productCategoryMap)
          .where(
            and(
              eq(productCategoryMap.pId, product.pId),
              eq(productCategoryMap.categoryId, categoryId),
            ),
          ),
      )
    : undefined;
}

/**
 * The branch a branch-scoped analytics call is about: always the caller's
 * own. A branch account without a branch shouldn't exist, but if one did,
 * querying `branch_id = null` would just come back empty and look like an
 * answer.
 */
function ownBranchId(actor: ScopedActor): number {
  if (actor.branchId === null) {
    throw new AppError("FORBIDDEN", {
      reason: "the caller isn't assigned to a branch",
    });
  }
  return actor.branchId;
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
          completedSale({ from, to }),
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
          inCategory(query.categoryId),
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

  /** The best-seller ranking, always for the caller's own branch. */
  async rankBranchSellers(
    actor: ScopedActor,
    query: BranchSellerRankingQuery,
  ): Promise<SellerRankingResult> {
    return this.rankSellers("best", {
      ...query,
      branchId: ownBranchId(actor),
    });
  },

  /**
   * Dead stock at the caller's branch: active products it has on hand that
   * didn't sell there at all in the timeframe. "On hand" is exactly what the
   * branch inventory listing counts (`branchOnHandLots`) — completed lots
   * with stock left that haven't expired — so the two screens agree.
   * Expired stock is left out on purpose: expiry alerts already cover it,
   * and it can't be sold to clear it anyway.
   *
   * Most units on hand first — that's the stock tying up the most shelf
   * space. `lastSoldAt` looks past the window, so the branch can tell an item
   * that's slow this month from one that has never sold there.
   */
  async getDeadStock(
    actor: ScopedActor,
    query: DeadStockQuery,
  ): Promise<DeadStockResult> {
    const branchId = ownBranchId(actor);
    const { from, to } = resolveTimeframe(query);
    const limit = query.limit ?? DEFAULT_DEAD_STOCK_LIMIT;
    const offset = query.offset ?? 0;

    // One row per product with stock at this branch. The `order` join is
    // what branchOnHandLots filters lot status on.
    const onHand = db
      .select({
        pId: branchOrderDetail.pId,
        onHandQuantity: sql<number>`sum(${branchOrderDetail.remain})::int`.as(
          "on_hand_quantity",
        ),
      })
      .from(branchOrderDetail)
      .innerJoin(order, eq(order.lotId, branchOrderDetail.lotId))
      .where(and(eq(branchOrderDetail.branchId, branchId), branchOnHandLots()))
      .groupBy(branchOrderDetail.pId)
      .as("on_hand");

    // This branch's sales of the outer query's product — correlated on
    // product.pId, so these run per row rather than joining every sale in.
    const salesHere = (window?: { from: Date; to: Date }) =>
      and(
        eq(customerOrderDetail.pId, product.pId),
        eq(customerOrderDetail.branchId, branchId),
        completedSale(window),
      );

    const where = and(
      eq(product.isActive, true),
      notExists(
        db
          .select({ pId: customerOrderDetail.pId })
          .from(customerOrderDetail)
          .innerJoin(order, eq(order.lotId, customerOrderDetail.lotId))
          .where(salesHere({ from, to })),
      ),
      inCategory(query.categoryId),
    );

    const lastSoldAt = sql`(${db
      .select({ at: max(order.createdAt) })
      .from(customerOrderDetail)
      .innerJoin(order, eq(order.lotId, customerOrderDetail.lotId))
      .where(salesHere())})`.mapWith(order.createdAt);

    const [rows, [{ totalCount }]] = await Promise.all([
      db
        .select({
          pId: product.pId,
          productName: product.name,
          barcode: product.barcode,
          onHandQuantity: onHand.onHandQuantity,
          lastSoldAt,
        })
        .from(product)
        .innerJoin(onHand, eq(onHand.pId, product.pId))
        .where(where)
        .orderBy(desc(onHand.onHandQuantity), asc(product.pId))
        .limit(limit)
        .offset(offset),
      db
        .select({ totalCount: count() })
        .from(product)
        .innerJoin(onHand, eq(onHand.pId, product.pId))
        .where(where),
    ]);

    const categoriesByProduct = await categoriesFor(rows.map((row) => row.pId));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalCount,
      result: rows.map((row) => ({
        ...row,
        categories: categoriesByProduct.get(row.pId) ?? [],
        lastSoldAt: row.lastSoldAt?.toISOString() ?? null,
      })),
    };
  },
};
