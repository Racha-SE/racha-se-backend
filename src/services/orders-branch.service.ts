import type {
  OrdersBranchCreateBody,
  OrdersBranchCreateResponse,
  LotDeduction,
} from "@/models/orders-branch.model";
import { db } from "@/db/client";
import { eq, sql } from "drizzle-orm";
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
      const products = await tx.query.product.findMany({
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
                        eq(order.orderType, "hq"),
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
      });

      const productMap = new Map(products.map((item) => [item.pId, item]));

      const [newOrder] = await tx
        .insert(order)
        .values({
          orderType: "branch",
          userId,
        })
        .returning();

      const hodIdsMapping: Omit<LotDeduction, "bodId">[][] = [];

      const newBOD = items.items.map((item) => {
        const product = productMap.get(item.pId);
        if (!product) {
          throw new AppError("NOT_FOUND", {
            message: "Product not found",
          });
        }

        const productHQSum = product.headOrderDetails.reduce(
          (sum, hod) => sum + hod.available,
          0,
        );

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
          item.amount -= deductAmount;
          expiredDates.push(hod.expiredDate);
          hodIds.push({ hodId: hod.hodId, amount: deductAmount });
        });

        hodIdsMapping.push(hodIds);

        return {
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
        };
      });

      const deductions = hodIdsMapping.flat();

      await tx.execute(sql`
        update ${headOrderDetail}
        set ${sql.identifier("available")} = ${headOrderDetail.available} - v.deduct
        from (values ${sql.join(
          deductions.map(
            ({ hodId, amount }) => sql`(${hodId}::int, ${amount}::int)`,
          ),
          sql`, `,
        )}) as v(hod_id, deduct)
        where ${headOrderDetail.hodId} = v.hod_id
      `);

      const branchOrderDetails = await tx
        .insert(branchOrderDetail)
        .values(newBOD)
        .returning();

      const bodIds = branchOrderDetails.map((bod) => bod.bodId);

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
          const { lotId: _, ...branchOrderDetail } = item;
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
