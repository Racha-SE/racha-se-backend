import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { headOrderDetail, notification, order, product } from "@/db/schema";
import type { OrdersHqCreateBody } from "@/models/orders-hq.model";
import { AppError } from "@/utils";

export const ordersHqService = {
  async create(userId: string, { items }: OrdersHqCreateBody) {
    const productIds = items.map((item) => item.pId);

    return db.transaction(async (tx) => {
      const products = await tx.query.product.findMany({
        where: (product, { inArray, and, eq }) =>
          and(inArray(product.pId, productIds), eq(product.isActive, true)),
      });

      const mappedProducts = new Map(
        products.map((product) => [product.pId, product]),
      );

      const [newOrder] = await tx
        .insert(order)
        .values({
          userId,
          orderType: "hq",
          status: "approved",
          approvedBy: userId,
          approvedAt: new Date(),
        })
        .returning();

      const insertedHeadOrderDetails = items.map((item) => {
        const product = mappedProducts.get(item.pId);
        if (!product) {
          throw new AppError("NOT_FOUND", {
            message: "product not found",
            pId: item.pId,
          });
        }

        return {
          lotId: newOrder.lotId,
          amount: item.amount,
          remain: item.amount,
          expiredDate: new Date(item.expiredDate),
          supplierId: item.supplierId,
          pId: item.pId,
          basePrice: item.basePrice,
        };
      });

      const newHeadOrderDetails = await tx
        .insert(headOrderDetail)
        .values(insertedHeadOrderDetails)
        .returning();

      // Stock just landed in HQ, so any product whose total remaining stock is
      // back at/above its minStockHq no longer justifies an open HQ min_stock
      // notification — resolve it (see notification.service.ts's top comment).
      // The rows above are already inserted in this tx, so the sum includes them.
      const restockedPIds = tx
        .select({ pId: headOrderDetail.pId })
        .from(headOrderDetail)
        .innerJoin(product, eq(product.pId, headOrderDetail.pId))
        .where(inArray(headOrderDetail.pId, productIds))
        .groupBy(headOrderDetail.pId, product.minStockHq)
        .having(
          gte(sql<number>`sum(${headOrderDetail.remain})`, product.minStockHq),
        );

      await tx
        .update(notification)
        .set({ isResolved: true, resolvedAt: new Date() })
        .where(
          and(
            eq(notification.type, "min_stock"),
            isNull(notification.resolvedAt),
            isNull(notification.branchId), // HQ-scoped only
            eq(notification.isResolved, false),
            inArray(notification.pId, restockedPIds),
          ),
        );

      return {
        ...newOrder,
        items: newHeadOrderDetails.map((newHod) => {
          const { lotId: _, ...rest } = newHod;
          return rest;
        }),
      };
    });
  },
};
