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
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  branch,
  branchOrderDetail,
  headOrderDetail,
  notification,
  order,
  product,
  user,
} from "@/db/schema";
import { AppError } from "@/utils/error";
import { UserType } from "@/utils/hierarchy";

const DEFAULT_LIMIT = 10;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function utcTimestamp(value: Date) {
  return sql`${value.toISOString()}::timestamp`;
}

type OrderStatus = (typeof order.status.enumValues)[number];

/**
 * Reads the branch order at `lotId` and holds it for the rest of the
 * transaction, so no two decisions can land on the same order: approve and
 * reject both wait on `pending`, receive waits on `approved`. Fails the way
 * the routes document it: 404 when there's no such branch order, 400 when the
 * order isn't in the state the caller needs.
 *
 * Only the order row is locked - the user join is there to tell the caller
 * which branch owns the order, and locking a user row would serialise every
 * order that branch user ever placed.
 */
async function lockOrder(
  tx: Transaction,
  lotId: number,
  expectedStatus: OrderStatus = "pending",
) {
  const [existing] = await tx
    .select({ order, branchId: user.branchId })
    .from(order)
    .innerJoin(user, eq(user.id, order.userId))
    .where(and(eq(order.lotId, lotId), eq(order.orderType, "branch")))
    .for("update", { of: order });

  if (!existing) {
    throw new AppError("NOT_FOUND", {
      message: "Branch order not found",
    });
  }

  if (existing.order.status !== expectedStatus) {
    throw new AppError("BAD_REQUEST", {
      message: `Branch order is ${existing.order.status}, expected ${expectedStatus}`,
    });
  }

  return { ...existing.order, branchId: existing.branchId };
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
      await lockOrder(tx, lotId);

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
      await lockOrder(tx, lotId);

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
  //
  // The head_order_detail deduction the TODO above asks for already happens
  // in `create`: picking the lots is what reserves them, so `remain` came
  // down there, branch_order_allocation recorded which lots it came off, and
  // quantity/expiry/price were copied into branch_order_detail at the same
  // time. Nothing is left to move here.
  //
  // What receipt does is flip the order to "completed". That's the line
  // between reserved and on hand - a branch_order_detail row only counts as
  // branch stock once its order is completed, the same way `create` only
  // draws from head_order_detail rows whose order is approved. It's also the
  // point HQ's post-deduction level is settled enough to raise an alert on.
  async receive(lotid: number, branchId?: number) {
    const now = new Date();

    return db.transaction(async (tx) => {
      if (!branchId) {
        throw new AppError("BAD_REQUEST", {
          message: "invalid branch user",
        });
      }
      // Holds the order row so two concurrent receives can't both read
      // "approved" and complete it twice. A branch only ever signs for a
      // delivery HQ approved, so that's the state this waits on.
      const branchOrder = await lockOrder(tx, lotid, "approved");

      if (branchOrder.branchId !== branchId) {
        throw new AppError("FORBIDDEN", {
          message: "not branch owner",
        });
      }

      const details = await tx
        .select({ pId: branchOrderDetail.pId })
        .from(branchOrderDetail)
        .where(eq(branchOrderDetail.lotId, lotid));

      const pIds = [...new Set(details.map((detail) => detail.pId))];

      // Lock the products before touching notifications - two receives
      // landing on the same product at once would otherwise both find no open
      // HQ alert and both insert one.
      await tx
        .select({ pId: product.pId })
        .from(product)
        .where(inArray(product.pId, pIds))
        .orderBy(product.pId)
        .for("update");

      await tx
        .update(order)
        .set({ status: "completed", receivedAt: now })
        .where(eq(order.lotId, lotid));

      // What this branch holds now that the order counts - the update above
      // has to run first for these lines to be included. Unexpired only, the
      // same way HQ stock is counted; branch_order_detail.expiredDate is
      // nullable, and a line with no expiry never goes bad.
      const branchStock = tx
        .select({
          pId: branchOrderDetail.pId,
          remain:
            sql<number>`coalesce(sum(${branchOrderDetail.remain}), 0)::int`.as(
              "branch_remain",
            ),
        })
        .from(branchOrderDetail)
        .innerJoin(order, eq(order.lotId, branchOrderDetail.lotId))
        .where(
          and(
            inArray(branchOrderDetail.pId, pIds),
            eq(branchOrderDetail.branchId, branchId),
            eq(order.status, "completed"),
            or(
              isNull(branchOrderDetail.expiredDate),
              gt(branchOrderDetail.expiredDate, now),
            ),
          ),
        )
        .groupBy(branchOrderDetail.pId)
        .as("branch_stock");

      // HQ's side of the same move: what's left for these products after the
      // deduction. Same definition of drawable as `create` uses - approved HQ
      // lots that haven't expired - so this matches what a later branch
      // request would actually be able to take.
      const hqStock = tx
        .select({
          pId: headOrderDetail.pId,
          remain:
            sql<number>`coalesce(sum(${headOrderDetail.remain}), 0)::int`.as(
              "hq_remain",
            ),
        })
        .from(headOrderDetail)
        .innerJoin(order, eq(order.lotId, headOrderDetail.lotId))
        .where(
          and(
            inArray(headOrderDetail.pId, pIds),
            eq(order.orderType, "hq"),
            eq(order.status, "approved"),
            gt(headOrderDetail.expiredDate, now),
          ),
        )
        .groupBy(headOrderDetail.pId)
        .as("hq_stock");

      // Both minimums and both stock levels in one pass - the decisions below
      // need all four per product. A product with nothing left on either side
      // has no row in that subquery at all, hence the left joins and the null
      // handling below. The two aggregates are aliased apart (branch_remain /
      // hq_remain) because Postgres resolves them unqualified out here, and
      // one shared name would be ambiguous across the two derived tables.
      const levels = await tx
        .select({
          pId: product.pId,
          minStockHq: product.minStockHq,
          minStockBranch: product.minStockBranch,
          branchRemain: branchStock.remain,
          hqRemain: hqStock.remain,
        })
        .from(product)
        .leftJoin(branchStock, eq(branchStock.pId, product.pId))
        .leftJoin(hqStock, eq(hqStock.pId, product.pId))
        .where(inArray(product.pId, pIds));

      // Only clear a branch alert the delivery actually answered. A partial
      // receipt that still leaves the product under its minimum keeps the
      // alert open, otherwise it would close for good - a branch alert is
      // only ever reopened by stock dropping below the minimum, and stock
      // that never came back up can't drop below it again.
      const resolvedPIds = levels
        .filter(
          ({ branchRemain, minStockBranch }) =>
            (branchRemain ?? 0) >= minStockBranch,
        )
        .map(({ pId }) => pId);

      if (resolvedPIds.length > 0) {
        await tx
          .update(notification)
          .set({ isResolved: true, resolvedAt: now })
          .where(
            and(
              eq(notification.type, "min_stock"),
              eq(notification.branchId, branchId),
              inArray(notification.pId, resolvedPIds),
              eq(notification.isResolved, false),
            ),
          );
      }

      const openHqAlerts = new Set(
        (
          await tx
            .select({ pId: notification.pId })
            .from(notification)
            .where(
              and(
                eq(notification.type, "min_stock"),
                isNull(notification.branchId),
                inArray(notification.pId, pIds),
                eq(notification.isResolved, false),
              ),
            )
        ).map(({ pId }) => pId),
      );

      // Keep an alert that's already open - its quantity is a snapshot from
      // when it was raised, not a live figure - and open one where the
      // product dropped below its HQ minimum with nothing open yet.
      const newHqAlerts = levels
        .filter(
          ({ pId, hqRemain, minStockHq }) =>
            !openHqAlerts.has(pId) && (hqRemain ?? 0) < minStockHq,
        )
        .map(({ pId, hqRemain }) => ({
          type: "min_stock" as const,
          branchId: null,
          pId,
          quantity: hqRemain ?? 0,
        }));

      if (newHqAlerts.length > 0) {
        await tx.insert(notification).values(newHqAlerts);
      }
    });
  },
};
