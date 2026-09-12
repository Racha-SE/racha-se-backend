import type {
  OrdersBranchCreateBody,
  OrdersBranchCreateResponse,
  LotDeduction,
} from "@/models/orders-branch.model";
import { db } from "@/db/client";
import { eq, inArray, sql } from "drizzle-orm";
import { branchOrderDetail, headOrderDetail, order } from "@/db/schema";
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
      //Lock for update
      await tx
        .select({ hodId: headOrderDetail.hodId })
        .from(headOrderDetail)
        .where(inArray(headOrderDetail.pId, pIds))
        .orderBy(headOrderDetail.hodId)
        .for("update");

      // Query all products and their head order details that are not expired and have available stock
      const products = await tx.query.product.findMany({
        columns: {
          pId: true,
          name: true,
          costPrice: true,
        },
        where: (product, { inArray, and, eq }) =>
          and(inArray(product.pId, pIds), eq(product.isActive, true)),
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
                        gt(headOrderDetail.remain, 0),
                      ),
                    ),
                ),
              ),
            orderBy: (headOrderDetail, { asc }) =>
              asc(headOrderDetail.expiredDate),
          },
        },
      });

      // Create a map of products for easy access
      const productMap = new Map(products.map((item) => [item.pId, item]));

      //Add new order to the database
      const [newOrder] = await tx
        .insert(order)
        .values({
          orderType: "branch",
          userId,
        })
        .returning();

      const hodIdsMapping: LotDeduction[][] = [];

      // Create new branch order details and update head order details
      const newBOD = items.items.map((item) => {
        const product = productMap.get(item.pId);
        if (!product) {
          throw new AppError("NOT_FOUND", {
            message: "Product not found",
          });
        }

        const productHQSum = product.headOrderDetails.reduce(
          (sum, hod) => sum + hod.remain,
          0,
        );

        if (productHQSum < item.amount) {
          throw new AppError("INSUFFICIENT_STOCK", {
            message: `Insufficient stock for product ${product?.name}`,
          });
        }

        const branchItemAmount = item.amount;
        let itemRemain = item.amount;

        const expiredDates: Date[] = [];

        const hodIds: LotDeduction[] = [];

        product.headOrderDetails.forEach((hod) => {
          if (itemRemain <= 0) return;
          const deductAmount = Math.min(hod.remain, itemRemain);
          itemRemain -= deductAmount;
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
          costPrice: product.costPrice,
          basePrice: product.headOrderDetails[0].basePrice,
          expiredDate: expiredDates[0],
        };
      });

      const deductions = hodIdsMapping.flat();

      //update head order details to deduct the remaining stock based on the branch order details
      await tx.execute(sql`
        update ${headOrderDetail}
        set ${sql.identifier("remain")} = ${headOrderDetail.remain} - v.deduct
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
