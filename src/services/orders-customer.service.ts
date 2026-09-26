import type {
  OrdersCustomerCancelResponse,
  OrdersCustomerConfirmPaymentResponse,
  OrdersCustomerCreateBody,
  OrdersCustomerCreateResponse,
  OrdersCustomerGetByLotIdResponse,
  OrdersCustomerGetResponse,
  OrdersCustomerQuery,
} from "@/models/orders-customer.model";
import { db } from "@/db/client";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  branch,
  branchOrderDetail,
  customerOrderDetail,
  order,
  user,
} from "@/db/schema";
import { notificationService } from "@/services/notification.service";
import { AppError } from "@/utils/error";

const DEFAULT_LIMIT = 10;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function utcTimestamp(value: Date) {
  return sql`${value.toISOString()}::timestamp`;
}

type OrderStatus = (typeof order.status.enumValues)[number];

interface DrawableLot {
  bodId: number;
  remain: number;
  expiredDate: Date | null;
  basePrice: number;
}

interface LineDraw {
  pId: number;
  bodId: number;
  amount: number;
  expiredDate: Date;
  basePrice: number;
}

// Own lock helper, not shared with orders-branch.service.ts's lockOrder —
// one per order-type service is this codebase's convention.
async function lockCustomerOrder(
  tx: Transaction,
  lotId: number,
  expectedStatus: OrderStatus = "pending",
) {
  const [existing] = await tx
    .select()
    .from(order)
    .where(and(eq(order.lotId, lotId), eq(order.orderType, "customer")))
    .for("update", { of: order });

  if (!existing) {
    throw new AppError("NOT_FOUND", { message: "Customer order not found" });
  }

  if (existing.status !== expectedStatus) {
    throw new AppError("BAD_REQUEST", {
      message: `Customer order is ${existing.status}, expected ${expectedStatus}`,
    });
  }

  return existing;
}

// Ordered by bodId so every caller (create, cancel) acquires these locks in
// the same sequence — prevents a deadlock between two transactions that
// touch overlapping lots.
async function lockBranchStock(
  tx: Transaction,
  branchId: number,
  pIds: number[],
) {
  await tx
    .select({ bodId: branchOrderDetail.bodId })
    .from(branchOrderDetail)
    .where(
      and(
        eq(branchOrderDetail.branchId, branchId),
        inArray(branchOrderDetail.pId, pIds),
      ),
    )
    .orderBy(branchOrderDetail.bodId)
    .for("update");
}

// Drawable stock for a branch: unexpired (or never-expiring), on a
// "completed" branch order, nearest-expiry first.
async function loadDrawableLots(
  tx: Transaction,
  branchId: number,
  pIds: number[],
  now: Date,
): Promise<Map<number, DrawableLot[]>> {
  const products = await tx.query.product.findMany({
    columns: { pId: true },
    where: (product, { inArray }) => inArray(product.pId, pIds),
    with: {
      branchOrderDetails: {
        where: (bod, { and, eq, gt, or, isNull, exists }) =>
          and(
            eq(bod.branchId, branchId),
            gt(bod.remain, 0),
            or(isNull(bod.expiredDate), gt(bod.expiredDate, now)),
            exists(
              tx
                .select({ lotId: order.lotId })
                .from(order)
                .where(
                  and(
                    eq(order.lotId, bod.lotId),
                    eq(order.orderType, "branch"),
                    eq(order.status, "completed"),
                  ),
                ),
            ),
          ),
        orderBy: (bod, { asc }) => asc(bod.expiredDate),
      },
    },
  });

  return new Map(
    products.map(({ pId, branchOrderDetails }) => [pId, branchOrderDetails]),
  );
}

// FEFO draw: one entry per (line, lot) actually drawn from, not collapsed to
// one row per pId — cancel() needs to credit back each lot exactly.
function drawFefoLines(
  lines: { pId: number; quantity: number }[],
  lotsByProduct: Map<number, DrawableLot[]>,
): LineDraw[] {
  const draws: LineDraw[] = [];

  for (const line of lines) {
    const lots = lotsByProduct.get(line.pId) ?? [];
    const availableAmount = lots.reduce((sum, lot) => sum + lot.remain, 0);

    if (availableAmount < line.quantity) {
      throw new AppError("INSUFFICIENT_STOCK", {
        message: `Insufficient stock for product ${line.pId}`,
        pId: line.pId,
        requested: line.quantity,
        availableAmount,
      });
    }

    let outstanding = line.quantity;

    for (const lot of lots) {
      if (outstanding <= 0) break;
      const drawn = Math.min(lot.remain, outstanding);
      if (drawn <= 0) continue;
      outstanding -= drawn;

      if (!lot.expiredDate) {
        // never actually null for stock that's "completed" and drawable here
        throw new AppError("INTERNAL_SERVER_ERROR", {
          message: "drawable branch lot missing expiredDate",
        });
      }

      draws.push({
        pId: line.pId,
        bodId: lot.bodId,
        amount: drawn,
        expiredDate: lot.expiredDate,
        basePrice: lot.basePrice,
      });
    }
  }

  return draws;
}

async function applyBranchStockDeduction(
  tx: Transaction,
  draws: { bodId: number; amount: number }[],
  now: Date,
) {
  if (draws.length === 0) return;

  await tx.execute(sql`
    update ${branchOrderDetail}
    set ${sql.identifier("remain")} = ${branchOrderDetail.remain} - v.amount,
        ${sql.identifier("updated_at")} = ${utcTimestamp(now)}
    from (values ${sql.join(
      draws.map(({ bodId, amount }) => sql`(${bodId}::int, ${amount}::int)`),
      sql`, `,
    )}) as v(bod_id, amount)
    where ${branchOrderDetail.bodId} = v.bod_id
  `);
}

// Compensating mirror of applyBranchStockDeduction.
async function restoreBranchStock(
  tx: Transaction,
  draws: { bodId: number; amount: number }[],
  now: Date,
) {
  if (draws.length === 0) return;

  await tx.execute(sql`
    update ${branchOrderDetail}
    set ${sql.identifier("remain")} = ${branchOrderDetail.remain} + v.amount,
        ${sql.identifier("updated_at")} = ${utcTimestamp(now)}
    from (values ${sql.join(
      draws.map(({ bodId, amount }) => sql`(${bodId}::int, ${amount}::int)`),
      sql`, `,
    )}) as v(bod_id, amount)
    where ${branchOrderDetail.bodId} = v.bod_id
  `);
}

export const ordersCustomerService = {
  // Always scoped to the caller's own branch — branch/cashier only, no
  // hq-wide view of customer orders.
  async list(
    query: OrdersCustomerQuery,
    branchId: number,
  ): Promise<OrdersCustomerGetResponse> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;

    const where = and(
      eq(order.orderType, "customer"),
      query.status ? eq(order.status, query.status) : undefined,
      eq(branch.branchId, branchId),
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
          .from(customerOrderDetail)
          .where(inArray(customerOrderDetail.lotId, lotIds))
          .orderBy(asc(customerOrderDetail.codId))
      : [];

    const itemsByLotId = new Map<
      number,
      Omit<(typeof details)[number], "lotId" | "bodId">[]
    >();

    for (const { lotId, bodId: _bodId, ...item } of details) {
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

  // Always scoped to the caller's own branch — branch/cashier only, no
  // hq-wide view of customer orders.
  async getById(
    lotId: number,
    branchId: number,
  ): Promise<OrdersCustomerGetByLotIdResponse> {
    const customerOrder = await db.query.order.findFirst({
      where: (order, { and, eq }) =>
        and(eq(order.lotId, lotId), eq(order.orderType, "customer")),
      with: {
        customerOrderDetails: {
          orderBy: (customerOrderDetail, { asc }) =>
            asc(customerOrderDetail.codId),
        },
        user: {
          columns: { branchId: true },
        },
      },
    });

    if (!customerOrder) {
      throw new AppError("NOT_FOUND", {
        message: "Customer order not found",
      });
    }

    if (customerOrder.user.branchId !== branchId) {
      throw new AppError("FORBIDDEN", {
        message: "This customer order belongs to another branch",
      });
    }

    const { customerOrderDetails, user: _user, ...orderFields } = customerOrder;

    return {
      ...orderFields,
      items: customerOrderDetails.map(
        ({ lotId: _lotId, bodId: _bodId, ...item }) => item,
      ),
    };
  },

  // Saga "Try": reserves stock for real, immediately, for both payment
  // methods — cash completes here; qr stays pending but the units are
  // already gone, so confirm-payment can never fail on stock.
  async create(
    userId: string,
    branchId: number,
    body: OrdersCustomerCreateBody,
  ): Promise<OrdersCustomerCreateResponse> {
    const pIds = body.items.map((item) => item.pId);
    const now = new Date();

    const products = await db.query.product.findMany({
      columns: { pId: true },
      where: (product, { inArray, and, eq }) =>
        and(inArray(product.pId, pIds), eq(product.isActive, true)),
    });
    const activeProductIds = new Set(products.map((p) => p.pId));
    for (const pId of pIds) {
      if (!activeProductIds.has(pId)) {
        throw new AppError("NOT_FOUND", { message: "Product not found" });
      }
    }

    return db.transaction(async (tx) => {
      await lockBranchStock(tx, branchId, pIds);
      const lotsByProduct = await loadDrawableLots(tx, branchId, pIds, now);
      const draws = drawFefoLines(body.items, lotsByProduct);

      await applyBranchStockDeduction(tx, draws, now);

      for (const pId of new Set(pIds)) {
        await notificationService.checkMinStock(tx, branchId, pId);
      }

      const [newOrder] = await tx
        .insert(order)
        .values({
          orderType: "customer",
          userId,
          status: body.paymentMethod === "cash" ? "completed" : "pending",
        })
        .returning();

      const items = await tx
        .insert(customerOrderDetail)
        .values(
          draws.map((draw) => ({
            lotId: newOrder.lotId,
            pId: draw.pId,
            bodId: draw.bodId,
            quantity: draw.amount,
            branchId,
            expiredDate: draw.expiredDate,
            basePrice: draw.basePrice,
          })),
        )
        .returning();

      return {
        ...newOrder,
        items: items.map(({ lotId: _lotId, bodId: _bodId, ...item }) => item),
        ...(body.paymentMethod === "qr"
          ? { paymentUrl: `/orders/customer/${newOrder.lotId}/confirm-payment` }
          : {}),
      };
    });
  },

  // Saga "Confirm": no stock check — create() already reserved it for real.
  async confirmPayment(
    lotId: number,
  ): Promise<OrdersCustomerConfirmPaymentResponse> {
    return db.transaction(async (tx) => {
      await lockCustomerOrder(tx, lotId, "pending");

      const [completed] = await tx
        .update(order)
        .set({ status: "completed" })
        .where(eq(order.lotId, lotId))
        .returning();

      const details = await tx
        .select()
        .from(customerOrderDetail)
        .where(eq(customerOrderDetail.lotId, lotId));

      return {
        ...completed,
        items: details.map(({ lotId: _lotId, bodId: _bodId, ...item }) => item),
      };
    });
  },

  // Saga "Cancel": the compensating step — credits the exact reserved units
  // back to the exact lot(s) they came from.
  async cancel(
    lotId: number,
    branchId: number,
  ): Promise<OrdersCustomerCancelResponse> {
    const now = new Date();

    return db.transaction(async (tx) => {
      await lockCustomerOrder(tx, lotId, "pending");

      const details = await tx
        .select()
        .from(customerOrderDetail)
        .where(eq(customerOrderDetail.lotId, lotId));

      if (details[0].branchId !== branchId) {
        throw new AppError("FORBIDDEN", {
          message: "This customer order belongs to another branch",
        });
      }

      // Same ascending-bodId lock discipline as create() uses, so the two
      // never deadlock against each other over an overlapping lot.
      const pIds = [...new Set(details.map((item) => item.pId))];
      await lockBranchStock(tx, branchId, pIds);

      await restoreBranchStock(
        tx,
        details.map((item) => ({ bodId: item.bodId, amount: item.quantity })),
        now,
      );

      for (const pId of pIds) {
        await notificationService.checkMinStock(tx, branchId, pId);
      }

      const [rejected] = await tx
        .update(order)
        .set({ status: "rejected" })
        .where(eq(order.lotId, lotId))
        .returning();

      return {
        ...rejected,
        items: details.map(({ lotId: _lotId, bodId: _bodId, ...item }) => item),
      };
    });
  },
};
