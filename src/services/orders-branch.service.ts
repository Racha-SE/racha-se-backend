import type {
  OrdersBranchCreateBody,
  OrdersBranchCreateResponse,
} from "@/models/orders-branch.model";
import { db } from "@/db/client";
import { branchOrderDetail, order } from "@/db/schema";
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

    return db.transaction(async (tx) => {
      // A branch order is only a request, so nothing here reads or touches
      // head_order_detail: which HQ lots fill it - and whether HQ can cover
      // it at all - is settled when HQ approves.
      const products = await tx.query.product.findMany({
        columns: {
          pId: true,
          costPrice: true,
        },
        where: (product, { inArray, and, eq }) =>
          and(inArray(product.pId, pIds), eq(product.isActive, true)),
      });

      // Create a map of products for easy access
      const productMap = new Map(products.map((item) => [item.pId, item]));

      // Built before the order row so a deactivated or missing product costs
      // nothing: Postgres keeps a serial it handed out even when the
      // transaction rolls back.
      const lines = items.items.map((item) => {
        const product = productMap.get(item.pId);
        if (!product) {
          throw new AppError("NOT_FOUND", {
            message: "Product not found",
          });
        }

        return {
          pId: item.pId,
          amount: item.amount,
          branchId,
          // the branch holds none of this yet - remain, expiredDate and
          // basePrice are filled in once the order is approved and received
          remain: 0,
          costPrice: product.costPrice,
        };
      });

      //Add new order to the database
      const [newOrder] = await tx
        .insert(order)
        .values({
          orderType: "branch",
          userId,
        })
        .returning();

      const branchOrderDetails = await tx
        .insert(branchOrderDetail)
        .values(lines.map((line) => ({ ...line, lotId: newOrder.lotId })))
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
