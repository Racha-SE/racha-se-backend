import { db } from "@/db/client";
import { and, eq, gte, lte } from "drizzle-orm";
import {
  order,
  customerOrderDetail,
  branchOrderDetail,
  product,
  branch,
} from "@/db/schema";
import type { SalesReportRow } from "@/models/reports.model";
import { endOfDay, startOfDay } from "date-fns";

export const reportsService = {
  async getSalesAndProfitReport(
    startDateStr: string,
    endDateStr: string,
  ): Promise<SalesReportRow[]> {
    const startDate = startOfDay(new Date(startDateStr));
    const endDate = endOfDay(new Date(endDateStr));

    // Cost comes from the specific lot a sale actually drew from
    // (branchOrderDetail.costPrice, via customerOrderDetail.bodId) — not
    // product.price, which is the global selling price, not a cost at all.
    const rawData = await db
      .select({
        createdAt: order.createdAt,
        branchName: branch.name,
        orderId: order.lotId,
        productName: product.name,
        quantity: customerOrderDetail.quantity,
        price: customerOrderDetail.price,
        costPrice: branchOrderDetail.costPrice,
      })
      .from(order)
      .innerJoin(
        customerOrderDetail,
        eq(order.lotId, customerOrderDetail.lotId),
      )
      .innerJoin(product, eq(customerOrderDetail.pId, product.pId))
      .innerJoin(branch, eq(customerOrderDetail.branchId, branch.branchId))
      .innerJoin(
        branchOrderDetail,
        eq(customerOrderDetail.bodId, branchOrderDetail.bodId),
      )
      .where(
        and(
          eq(order.orderType, "customer"),
          eq(order.status, "completed"),
          gte(order.createdAt, startDate),
          lte(order.createdAt, endDate),
        ),
      );

    return rawData.map((row) => {
      const totalSales = row.quantity * row.price;
      const totalProfit = (row.price - row.costPrice) * row.quantity;

      return {
        date: row.createdAt.toISOString().split("T")[0],
        branchName: row.branchName,
        orderId: row.orderId,
        productName: row.productName,
        quantity: row.quantity,
        unitPrice: row.price,
        unitCost: row.costPrice,
        totalSales,
        totalProfit,
      };
    });
  },
};
