import { db } from "@/db/client";
import { and, eq, gte, lte } from "drizzle-orm";
import { order, customerOrderDetail, product, branch } from "@/db/schema";
import type { SalesReportRow } from "@/models/reports.model";
import { endOfDay, startOfDay } from "date-fns";

export const reportsService = {
  async getSalesAndProfitReport(
    startDateStr: string,
    endDateStr: string,
  ): Promise<SalesReportRow[]> {
    const startDate = startOfDay(new Date(startDateStr));
    const endDate = endOfDay(new Date(endDateStr));

    const rawData = await db
      .select({
        createdAt: order.createdAt,
        branchName: branch.name,
        orderId: order.lotId,
        productName: product.name,
        quantity: customerOrderDetail.quantity,
        basePrice: customerOrderDetail.basePrice,
        costPrice: product.costPrice,
      })
      .from(order)
      .innerJoin(
        customerOrderDetail,
        eq(order.lotId, customerOrderDetail.lotId),
      )
      .innerJoin(product, eq(customerOrderDetail.pId, product.pId))
      .innerJoin(branch, eq(customerOrderDetail.branchId, branch.branchId))
      .where(
        and(
          eq(order.orderType, "customer"),
          eq(order.status, "completed"),
          gte(order.createdAt, startDate),
          lte(order.createdAt, endDate),
        ),
      );

    return rawData.map((row) => {
      const totalSales = row.quantity * row.basePrice;
      const totalProfit = (row.basePrice - row.costPrice) * row.quantity;

      return {
        date: row.createdAt.toISOString().split("T")[0],
        branchName: row.branchName,
        orderId: row.orderId,
        productName: row.productName,
        quantity: row.quantity,
        unitPrice: row.basePrice,
        unitCost: row.costPrice,
        totalSales,
        totalProfit,
      };
    });
  },
};
