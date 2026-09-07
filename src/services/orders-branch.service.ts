import type {
  OrdersBranchCreateBody,
  OrdersBranchCreateResponse,
  LotDeduction,
} from "@/models/orders-branch.model";
import { db } from "@/db/client";
import { product } from "@/db/schema/product";
import { eq, inArray, sum, and, gt, sql } from "drizzle-orm";
import {
  branchOrderAllocation,
  branchOrderDetail,
  headOrderDetail,
  order,
} from "@/db/schema";
import { AppError } from "@/utils/error";

export const ordersBranchService = {
  list(): Promise<null> {
    return Promise.resolve(null);
  },

  getById(): Promise<null> {
    return Promise.resolve(null);
  },

  async create(
    userId: string,
    branchId: number,
    items: OrdersBranchCreateBody,
  ): Promise<OrdersBranchCreateResponse> {
    const pIds = items.items.map((item) => item.pId);
    const now = new Date();

    return db.transaction(async (tx) => {
      const [products, productsCount] = await Promise.all([
        tx.query.product.findMany({
          columns: {
            pId: true,
            name: true,
            costPrice: true,
          },
          where: (product, { inArray }) => inArray(product.pId, pIds),
          with: {
            headOrderDetails: {
              where: (headOrderDetail, { and, gt, exists }) =>
                and(
                  gt(headOrderDetail.expiredDate, now),
                  exists(
                    tx
                      .select({ lotId: order.lotId })
                      .from(order)
                      .where(
                        and(
                          eq(order.lotId, headOrderDetail.lotId),
                          eq(order.status, "approved"),
                          gt(headOrderDetail.available, 0),
                        ),
                      ),
                  ),
                ),
              orderBy: (headOrderDetail, { asc }) =>
                asc(headOrderDetail.expiredDate),
            },
          },
        }),
        tx
          .select({
            pId: product.pId,
            sumAmount: sum(headOrderDetail.available),
          })
          .from(product)
          .leftJoin(headOrderDetail, eq(product.pId, headOrderDetail.pId))
          .leftJoin(order, eq(headOrderDetail.lotId, order.lotId))
          .where(
            and(
              inArray(product.pId, pIds),
              eq(order.status, "approved"),
              gt(headOrderDetail.expiredDate, now),
              gt(headOrderDetail.available, 0),
            ),
          )
          .groupBy(product.pId),
      ]);

      const productCountMap = new Map(
        productsCount.map((item) => [item.pId, Number(item.sumAmount ?? 0)]),
      );
      const productMap = new Map(products.map((item) => [item.pId, item]));

      const [newOrder] = await tx
        .insert(order)
        .values({
          orderType: "branch",
          userId,
        })
        .returning();

      const updatedHQStock: Promise<unknown>[] = [];

      const hodIdsMapping: Omit<LotDeduction, "bodId">[][] = [];

      const newBOD = items.items.map((item) => {
        const productHQSum = productCountMap.get(item.pId) ?? 0;
        const product = productMap.get(item.pId);
        if (!product) {
          throw new AppError("NOT_FOUND", {
            message: "Product not found",
          });
        }
        if (productHQSum < item.amount) {
          throw new AppError("INSUFFICIENT_STOCK", {
            message: `Insufficient stock for product ${product?.name}`,
          });
        }

        const branchItemAmount = item.amount;

        const expiredDates: Date[] = [];

        const hodIds: Omit<LotDeduction, "bodId">[] = [];

        product.headOrderDetails.forEach((hod) => {
          if (item.amount <= 0) return;
          const deductAmount = Math.min(hod.available, item.amount);
          updatedHQStock.push(
            tx
              .update(headOrderDetail)
              .set({
                available: sql`${headOrderDetail.available} - ${deductAmount}`,
              })
              .where(eq(headOrderDetail.hodId, hod.hodId)),
          );
          item.amount -= deductAmount;
          expiredDates.push(hod.expiredDate);
          hodIds.push({ hodId: hod.hodId, amount: deductAmount });
        });

        hodIdsMapping.push(hodIds);

        return tx
          .insert(branchOrderDetail)
          .values({
            lotId: newOrder.lotId,
            pId: item.pId,
            amount: branchItemAmount,
            branchId,
            remain: branchItemAmount,
            available: branchItemAmount,
            costPrice: product.costPrice,
            basePrice: product.headOrderDetails[0].basePrice,
            expiredDate: expiredDates.reduce(
              (minDate, date) => (date < minDate ? date : minDate),
              expiredDates[0],
            ),
          })
          .returning();
      });

      await Promise.all(updatedHQStock);
      const branchOrderDetails = await Promise.all(newBOD);

      const bodIds = branchOrderDetails.map(([bod]) => bod.bodId);

      const insertedBOAs: LotDeduction[] = hodIdsMapping.flatMap(
        (hodIds, index) => {
          const bodId = bodIds[index];
          return hodIds.map((hod) => {
            const insertedData = {
              bodId,
              ["hodId"]: hod.hodId,
              ["amount"]: hod.amount,
            };

            return insertedData;
          });
        },
      );

      await tx.insert(branchOrderAllocation).values(insertedBOAs);

      return {
        ...newOrder,
        items: branchOrderDetails.map((item) => {
          const { lotId: _, ...branchOrderDetail } = item[0];
          return branchOrderDetail;
        }),
      };
    });
  },

  approve(): Promise<null> {
    return Promise.resolve(null);
  },

  reject(): Promise<null> {
    return Promise.resolve(null);
  },

  // TODO: once this deducts head_order_detail and increments branch stock
  // for real, resolve the branch's min_stock notification for each product
  // received, and open/keep an HQ min_stock notification per product if the
  // HQ lot(s) remaining stock drops below product.minStockHq — see
  // notification.service.ts's top comment.
  receive(): Promise<null> {
    return Promise.resolve(null);
  },
};
