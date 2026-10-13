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

export const reportsService = {
  async getSalesAndProfitReport(
    actor: ScopedActor,
    startDateStr: string,
    endDateStr: string,
    branchSelectedId?: number,
  ): Promise<ReportResult[]> {
    const startDate = startOfDay(new Date(startDateStr));
    const endDate = endOfDay(new Date(endDateStr));
    const { branchId } = actor;

    if (branchSelectedId !== undefined) {
      const [existing] = await db
        .select({ branchId: branch.branchId })
        .from(branch)
        .where(eq(branch.branchId, branchSelectedId));
      if (!existing)
        throw new AppError("NOT_FOUND", { branchId: branchSelectedId });
    }

    if (branchId && branchSelectedId && branchId !== branchSelectedId) {
      throw new AppError("FORBIDDEN");
    }

    const [purchased, sales] = await Promise.all([
      // What the branch bought: received branch orders HQ approved in range,
      // costed at the costPrice stamped on the line when it was ordered.
      db
        .select({
          productId: product.pId,
          productName: product.name,
          quantity: sql<number>`coalesce(sum(${branchOrderDetail.amount}), 0)::int`,
          totalCost: sql<number>`coalesce(sum(${branchOrderDetail.amount} * ${branchOrderDetail.costPrice}), 0)::int`,
        })
        .from(branchOrderDetail)
        .innerJoin(order, eq(branchOrderDetail.lotId, order.lotId))
        .innerJoin(product, eq(branchOrderDetail.pId, product.pId))
        .where(
          and(
            branchId ? eq(branchOrderDetail.branchId, branchId) : undefined,
            branchSelectedId
              ? eq(branchOrderDetail.branchId, branchSelectedId)
              : undefined,
            eq(order.orderType, "branch"),
            eq(order.status, "completed"),
            gte(order.approvedAt, startDate),
            lte(order.approvedAt, endDate),
          ),
        )
        .groupBy(product.pId),

      // What the branch sold: paid customer orders placed in range, at the
      // price stamped on each sale.
      db
        .select({
          productId: product.pId,
          productName: product.name,
          salesQuantity: sql<number>`coalesce(sum(${customerOrderDetail.quantity}), 0)::int`,
          totalRevenue: sql<number>`coalesce(sum(${customerOrderDetail.quantity} * ${customerOrderDetail.price}), 0)::int`,
        })
        .from(customerOrderDetail)
        .innerJoin(order, eq(customerOrderDetail.lotId, order.lotId))
        .innerJoin(product, eq(customerOrderDetail.pId, product.pId))
        .where(
          and(
            branchId ? eq(customerOrderDetail.branchId, branchId) : undefined,
            eq(order.orderType, "customer"),
            eq(order.status, "completed"),
            gte(order.createdAt, startDate),
            lte(order.createdAt, endDate),
          ),
        )
        .groupBy(product.pId),
    ]);

    // A product can show up on only one side: bought in range but not sold
    // yet, or sold in range from stock bought before it.
    const report = new Map<number, ReportResult>();

    for (const row of purchased) {
      report.set(row.productId, {
        ...row,
        salesQuantity: 0,
        totalRevenue: 0,
        totalProfit: -row.totalCost,
      });
    }

    for (const row of sales) {
      const quantity = report.get(row.productId)?.quantity ?? 0;
      const totalCost = report.get(row.productId)?.totalCost ?? 0;

      report.set(row.productId, {
        ...row,
        quantity,
        totalCost,
        totalProfit: row.totalRevenue - totalCost,
      });
    }

    return Array.from(report.values()).sort(
      (a, b) => a.productId - b.productId,
    );
  },
};
