import type {
  OrdersBranchCreateBody,
  OrdersBranchCreateResponse,
  OrdersBranchGetByLotIdResponse,
  OrdersBranchGetResponse,
  OrdersBranchQuery,
} from "@/models/orders-branch.model";
import { db } from "@/db/client";
import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  branch,
  branchOrderDetail,
  headOrderDetail,
  order,
  user,
} from "@/db/schema";
import { AppError } from "@/utils/error";
import { UserType } from "@/utils/hierarchy";

const DEFAULT_LIMIT = 10;

export const ordersBranchService = {
  async list(
    userType: UserType,
    query: OrdersBranchQuery,
    branchId?: number,
  ): Promise<OrdersBranchGetResponse> {
    const scopedBranchId = userType === "hq" ? query.branchId : branchId;

    if (userType !== "hq" && scopedBranchId === undefined) {
      throw new AppError("BAD_REQUEST", {
        message: "Branch ID is required for listing branch orders.",
      });
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;

    const where = and(
      eq(order.orderType, "branch"),
      query.status ? eq(order.status, query.status) : undefined,
      scopedBranchId !== undefined
        ? eq(branch.branchId, scopedBranchId)
        : undefined,
    );

    const [rows, [{ totals }]] = await Promise.all([
      db
        .select({ order, branchId: branch.branchId })
        .from(order)
        .innerJoin(user, eq(user.id, order.userId))
        .innerJoin(branch, eq(branch.branchId, user.branchId))
        .where(where)
        .orderBy(desc(order.createdAt), desc(order.lotId))
        .limit(limit)
        .offset(offset),
      db
        .select({ totals: count() })
        .from(order)
        .innerJoin(user, eq(user.id, order.userId))
        .innerJoin(branch, eq(branch.branchId, user.branchId))
        .where(where),
    ]);

    const lotIds = rows.map((row) => row.order.lotId);

    const details = lotIds.length
      ? await db
          .select()
          .from(branchOrderDetail)
          .where(inArray(branchOrderDetail.lotId, lotIds))
          .orderBy(asc(branchOrderDetail.bodId))
      : [];

    const itemsByLotId = new Map<
      number,
      Omit<(typeof details)[number], "lotId">[]
    >();

    for (const { lotId, ...item } of details) {
      const items = itemsByLotId.get(lotId) ?? [];
      items.push(item);
      itemsByLotId.set(lotId, items);
    }

    return {
      orders: rows.map((row) => ({
        ...row.order,
        branchId: row.branchId,
        items: itemsByLotId.get(row.order.lotId) ?? [],
      })),
      limit,
      offset,
      totals,
    };
  },

  async getById(
    lotId: number,
    userType: UserType,
    branchId?: number,
  ): Promise<OrdersBranchGetByLotIdResponse> {
    const branchOrder = await db.query.order.findFirst({
      where: (order, { and, eq }) =>
        and(eq(order.lotId, lotId), eq(order.orderType, "branch")),
      with: {
        branchOrderDetails: {
          orderBy: (branchOrderDetail, { asc }) => asc(branchOrderDetail.bodId),
        },
        user: {
          columns: {
            branchId: true,
          },
        },
      },
    });

    if (!branchOrder) {
      throw new AppError("NOT_FOUND", {
        message: "Branch order not found",
      });
    }

    if (userType === "branch" && branchOrder.user.branchId !== branchId) {
      throw new AppError("FORBIDDEN", {
        message: "This branch order belongs to another branch",
      });
    }

    const { branchOrderDetails, user: _, ...orderFields } = branchOrder;
    const pIds = branchOrderDetails.map((item) => item.pId);

    const availability = pIds.length
      ? await db
          .select({
            pId: headOrderDetail.pId,
            availableAmount: sql<number>`coalesce(sum(${headOrderDetail.remain}), 0)::int`,
          })
          .from(headOrderDetail)
          .innerJoin(order, eq(order.lotId, headOrderDetail.lotId))
          .where(
            and(
              inArray(headOrderDetail.pId, pIds),
              gt(headOrderDetail.expiredDate, new Date()),
              eq(order.orderType, "hq"),
              eq(order.status, "approved"),
            ),
          )
          .groupBy(headOrderDetail.pId)
      : [];

    const availableMap = new Map(
      availability.map((row) => [row.pId, row.availableAmount]),
    );

    return {
      ...orderFields,
      items: branchOrderDetails.map(({ lotId: _, ...item }) => ({
        ...item,
        availableAmount: availableMap.get(item.pId) ?? 0,
      })),
    };
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
