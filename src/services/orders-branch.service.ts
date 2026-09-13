import type {
  OrdersBranchCreateBody,
  OrdersBranchCreateResponse,
  OrdersBranchGetByLotIdResponse,
  OrdersBranchGetResponse,
  LotDeduction,
  OrdersBranchQuery,
} from "@/models/orders-branch.model";
import { db } from "@/db/client";
import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  branch,
  branchOrderAllocation,
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

      const hodIdsMapping: Omit<LotDeduction, "bodId">[][] = [];

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

        const hodIds: Omit<LotDeduction, "bodId">[] = [];

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

      const bodIds = branchOrderDetails.map((bod) => bod.bodId);

      //insert branch order allocations to link the branch order details with the head order details
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
