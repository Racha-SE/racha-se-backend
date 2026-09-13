import type {
  OrdersBranchApproveResponse,
  OrdersBranchCreateBody,
  OrdersBranchCreateResponse,
  OrdersBranchGetByLotIdResponse,
  OrdersBranchGetResponse,
  OrdersBranchQuery,
  OrdersBranchRejectResponse,
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

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function utcTimestamp(value: Date) {
  return sql`${value.toISOString()}::timestamp`;
}

/**
 * Reads the branch order at `lotId` and holds it for the rest of the
 * transaction, so approve and reject can't both land on the same pending
 * order. Fails the way both routes document it: 404 when there's no such
 * branch order, 400 when someone has already decided on it.
 */
async function lockPendingOrder(tx: Transaction, lotId: number) {
  const [existing] = await tx
    .select()
    .from(order)
    .where(and(eq(order.lotId, lotId), eq(order.orderType, "branch")))
    .for("update");

  if (!existing) {
    throw new AppError("NOT_FOUND", {
      message: "Branch order not found",
    });
  }

  if (existing.status !== "pending") {
    throw new AppError("BAD_REQUEST", {
      message: `Branch order is already ${existing.status}`,
    });
  }

  return existing;
}

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

  /**
   * HQ fulfils a pending branch request: the lots that fill it are picked
   * here, not when the branch asked, so a request HQ can no longer cover
   * fails with INSUFFICIENT_STOCK at this point.
   */
  async approve(
    lotId: number,
    approverId: string,
  ): Promise<OrdersBranchApproveResponse> {
    const now = new Date();

    return db.transaction(async (tx) => {
      // Locking the order row first is what keeps two HQ users approving the
      // same order from both passing the stock check and drawing the lots
      // down twice.
      await lockPendingOrder(tx, lotId);

      const lines = await tx
        .select()
        .from(branchOrderDetail)
        .where(eq(branchOrderDetail.lotId, lotId));

      const pIds = lines.map((line) => line.pId);

      //Lock for update
      await tx
        .select({ hodId: headOrderDetail.hodId })
        .from(headOrderDetail)
        .where(inArray(headOrderDetail.pId, pIds))
        .orderBy(headOrderDetail.hodId)
        .for("update");

      // Query the head order details that can still fill these lines: an
      // approved HQ order, not expired, stock left. Nearest expiry first, so
      // the oldest stock leaves the warehouse first.
      const products = await tx.query.product.findMany({
        columns: {
          pId: true,
        },
        where: (product, { inArray }) => inArray(product.pId, pIds),
        with: {
          headOrderDetails: {
            where: (headOrderDetail, { and, gt, exists }) =>
              and(
                gt(headOrderDetail.expiredDate, now),
                gt(headOrderDetail.remain, 0),
                exists(
                  tx
                    .select({ lotId: order.lotId })
                    .from(order)
                    .where(
                      and(
                        eq(order.lotId, headOrderDetail.lotId),
                        eq(order.orderType, "hq"),
                        eq(order.status, "approved"),
                      ),
                    ),
                ),
              ),
            orderBy: (headOrderDetail, { asc }) =>
              asc(headOrderDetail.expiredDate),
          },
        },
      });

      const lotsByProduct = new Map(
        products.map(({ pId, headOrderDetails }) => [pId, headOrderDetails]),
      );

      const deductions: { hodId: number; amount: number }[] = [];

      // No two lines share a lot list - createBody rejects a repeated pId -
      // so each line can draw against its product's lots on its own.
      const filledLines = lines.map((line) => {
        const lots = lotsByProduct.get(line.pId) ?? [];
        const availableAmount = lots.reduce((sum, lot) => sum + lot.remain, 0);

        if (availableAmount < line.amount) {
          throw new AppError("INSUFFICIENT_STOCK", {
            message: `Insufficient stock for product ${line.pId}`,
            pId: line.pId,
            requested: line.amount,
            availableAmount,
          });
        }

        let outstanding = line.amount;
        const drawnFrom: typeof lots = [];

        for (const lot of lots) {
          if (outstanding <= 0) break;
          const drawn = Math.min(lot.remain, outstanding);
          outstanding -= drawn;
          deductions.push({ hodId: lot.hodId, amount: drawn });
          drawnFrom.push(lot);
        }

        return {
          bodId: line.bodId,
          // the line stays one row even when it spans lots, so the expiry and
          // price it carries are the nearest-expiry lot's
          remain: line.amount,
          expiredDate: drawnFrom[0].expiredDate,
          basePrice: drawnFrom[0].basePrice,
        };
      });

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

      // update branch order details and push item in items

      await tx.execute(sql`
        update ${branchOrderDetail}
        set ${sql.identifier("remain")} = v.remain,
            ${sql.identifier("expired_date")} = v.expired_date,
            ${sql.identifier("base_price")} = v.base_price,
            ${sql.identifier("updated_at")} = ${utcTimestamp(now)}
        from (values ${sql.join(
          filledLines.map(
            ({ bodId, remain, expiredDate, basePrice }) =>
              sql`(${bodId}::int, ${remain}::int, ${utcTimestamp(expiredDate)}, ${basePrice}::int)`,
          ),
          sql`, `,
        )})
          as v(bod_id, remain, expired_date, base_price)
          where ${branchOrderDetail.bodId} = v.bod_id
        `);

      // set status to approved
      const [approved] = await tx
        .update(order)
        .set({ status: "approved", approvedBy: approverId, approvedAt: now })
        .where(eq(order.lotId, lotId))
        .returning();

      const items = (
        await tx
          .select()
          .from(branchOrderDetail)
          .where(eq(branchOrderDetail.lotId, lotId))
      ).map((item) => {
        const { lotId: _, ...updatedBranchOrderDetail } = item;
        return updatedBranchOrderDetail;
      });

      return { ...approved, items };
    });
  },

  /**
   * HQ turns a pending branch request down. Nothing has to be given back:
   * the HQ lots are only drawn on at approve, so a request that never got
   * there never held any stock.
   */
  async reject(lotId: number): Promise<OrdersBranchRejectResponse> {
    return db.transaction(async (tx) => {
      await lockPendingOrder(tx, lotId);

      const [rejected] = await tx
        .update(order)
        .set({ status: "rejected" })
        .where(eq(order.lotId, lotId))
        .returning();

      const branchOrderDetails = await tx
        .select()
        .from(branchOrderDetail)
        .where(eq(branchOrderDetail.lotId, lotId));

      return {
        ...rejected,
        items: branchOrderDetails.map((item) => {
          const { lotId: _, ...branchOrderDetail } = item;
          return branchOrderDetail;
        }),
      };
    });
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
