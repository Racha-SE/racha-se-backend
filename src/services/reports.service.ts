import { db } from "@/db/client";
import { and, eq, gte, lte } from "drizzle-orm";
import {
  order,
  customerOrderDetail,
  branchOrderDetail,
  product,
  branch,
} from "@/db/schema";
import { endOfDay, startOfDay } from "date-fns";
import { ReportResult } from "@/models/reports.model";

export const reportsService = {
  async getSalesAndProfitReport(
    startDateStr: string,
    endDateStr: string,
  ): Promise<ReportResult[]> {
    const startDate = startOfDay(new Date(startDateStr));
    const endDate = endOfDay(new Date(endDateStr));

    const _rawData = await db
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

    return [];
  },
};
