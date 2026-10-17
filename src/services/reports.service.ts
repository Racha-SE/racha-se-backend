import { db } from "@/db/client";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  order,
  customerOrderDetail,
  product,
  branch,
  branchOrderDetail,
} from "@/db/schema";
import { endOfDay, startOfDay } from "date-fns";
import { type ReportResult } from "@/models/reports.model";
import { AppError, type ScopedActor } from "@/utils";
import { categoriesFor } from "@/services/products.service";

export const reportsService = {
  async getSalesAndProfitReport(
    actor: ScopedActor,
    startDateStr: string,
    endDateStr: string,
    branchSelectedId?: number,
  ): Promise<ReportResult[]> {
    const startDate = startOfDay(new Date(startDateStr));
    const endDate = endOfDay(new Date(endDateStr));
    const { userType, branchId } = actor;

    if (endDate < startDate) {
      throw new AppError("BAD_REQUEST", {
        message: "End date cannot be before start date",
      });
    }

    if (
      userType === "branch" &&
      branchId &&
      branchSelectedId &&
      branchId !== branchSelectedId
    ) {
      throw new AppError("FORBIDDEN");
    }

    if (branchSelectedId !== undefined) {
      const [existing] = await db
        .select({ branchId: branch.branchId })
        .from(branch)
        .where(eq(branch.branchId, branchSelectedId));
      if (!existing)
        throw new AppError("NOT_FOUND", { branchId: branchSelectedId });
    }

    const branchToSelectedCondition = and(
      branchId && userType === "branch"
        ? eq(customerOrderDetail.branchId, branchId)
        : undefined,
      branchSelectedId && userType === "hq"
        ? eq(customerOrderDetail.branchId, branchSelectedId)
        : undefined,
    );

    // Paid customer orders placed in range. Revenue is the price stamped on
    // each sale; cost is the costPrice of the exact lot each sale drew from
    // (via bodId) — so stock bought but not yet sold never counts as cost.
    const rows = await db
      .select({
        productId: product.pId,
        productName: product.name,
        salesQuantity: sql<number>`coalesce(sum(${customerOrderDetail.quantity}), 0)::int`,
        revenue: sql<number>`coalesce(sum(${customerOrderDetail.quantity} * ${customerOrderDetail.price}), 0)::int`,
        cost: sql<number>`coalesce(sum(${customerOrderDetail.quantity} * ${branchOrderDetail.costPrice}), 0)::int`,
      })
      .from(customerOrderDetail)
      .innerJoin(order, eq(customerOrderDetail.lotId, order.lotId))
      .innerJoin(product, eq(customerOrderDetail.pId, product.pId))
      .innerJoin(
        branchOrderDetail,
        eq(customerOrderDetail.bodId, branchOrderDetail.bodId),
      )
      .where(
        and(
          branchToSelectedCondition,
          eq(order.orderType, "customer"),
          eq(order.status, "completed"),
          gte(order.createdAt, startDate),
          lte(order.createdAt, endDate),
        ),
      )
      .groupBy(product.pId)
      .orderBy(product.pId);

    const categoriesByProduct = await categoriesFor(
      rows.map((row) => row.productId),
    );

    return rows.map((row) => ({
      ...row,
      profit: row.revenue - row.cost,
      categories: (categoriesByProduct.get(row.productId) ?? []).map(
        ({ categoryName }) => categoryName,
      ),
    }));
  },
};
