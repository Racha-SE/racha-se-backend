import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branchOrderDetail,
  order,
  product,
  stockAdjustment,
} from "@/db/schema";
import type {
  StockAdjustmentCreateBody,
  StockAdjustmentCreateResponse,
} from "@/models/stock-adjustments.model";
import { notificationService } from "@/services/notification.service";
import {
  loadDrawableLots,
  lockBranchStock,
} from "@/services/orders-customer.service";
import { AppError } from "@/utils/error";
import { assertBranchScope, type ScopedActor } from "@/utils/hierarchy";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function utcTimestamp(value: Date) {
  return sql`${value.toISOString()}::timestamp`;
}

/**
 * The newest unexpired lot this branch has received of a product, even one
 * that's sold out - where a positive correction ("we have more than the
 * system says") goes back on. A branch can't hold more of a product than it
 * was ever sent, so a product it never received has nowhere to add to.
 */
async function findLotToTopUp(
  tx: Transaction,
  branchId: number,
  pId: number,
  now: Date,
) {
  const [lot] = await tx
    .select({ bodId: branchOrderDetail.bodId })
    .from(branchOrderDetail)
    .innerJoin(order, eq(order.lotId, branchOrderDetail.lotId))
    .where(
      and(
        eq(branchOrderDetail.branchId, branchId),
        eq(branchOrderDetail.pId, pId),
        eq(order.orderType, "branch"),
        eq(order.status, "completed"),
        or(
          isNull(branchOrderDetail.expiredDate),
          gt(branchOrderDetail.expiredDate, now),
        ),
      ),
    )
    .orderBy(desc(branchOrderDetail.bodId))
    .limit(1);

  return lot;
}

export const stockAdjustmentsService = {
  /**
   * Corrects a branch's stock of one product to match the shelf and records
   * why. A negative change comes off on-hand lots nearest-expiry first (the
   * same lots and order a sale draws from), and can't take more than is on
   * hand. A positive change goes onto the newest unexpired lot. Either way
   * the branch's min_stock alert for the product is re-checked, the same as
   * after a sale.
   */
  async create(
    actor: ScopedActor,
    branchId: number,
    body: StockAdjustmentCreateBody,
  ): Promise<StockAdjustmentCreateResponse> {
    assertBranchScope(actor, branchId);

    const [found] = await db
      .select({ pId: product.pId })
      .from(product)
      .where(eq(product.pId, body.pId));
    if (!found) {
      throw new AppError("NOT_FOUND", { message: "Product not found" });
    }

    const now = new Date();

    return db.transaction(async (tx) => {
      // Same lock order as customer orders, so an adjustment and a sale on
      // the same product queue up instead of deadlocking.
      await lockBranchStock(tx, branchId, [body.pId]);

      const lots = (await loadDrawableLots(tx, branchId, [body.pId], now)).get(
        body.pId,
      );
      const onHandBefore = (lots ?? []).reduce(
        (total, lot) => total + lot.remain,
        0,
      );

      if (body.quantityChange < 0) {
        const toRemove = -body.quantityChange;

        if (onHandBefore < toRemove) {
          throw new AppError("INSUFFICIENT_STOCK", {
            message: `Insufficient stock for product ${body.pId}`,
            pId: body.pId,
            requested: toRemove,
            availableAmount: onHandBefore,
          });
        }

        let outstanding = toRemove;
        for (const lot of lots ?? []) {
          if (outstanding <= 0) break;
          const drawn = Math.min(lot.remain, outstanding);
          outstanding -= drawn;

          await tx
            .update(branchOrderDetail)
            .set({
              remain: sql`${branchOrderDetail.remain} - ${drawn}`,
              updatedAt: sql`${utcTimestamp(now)}`,
            })
            .where(eq(branchOrderDetail.bodId, lot.bodId));
        }
      } else {
        const lot = await findLotToTopUp(tx, branchId, body.pId, now);

        if (!lot) {
          throw new AppError("BAD_REQUEST", {
            message: `No unexpired stock of product ${body.pId} has been received at this branch`,
            pId: body.pId,
          });
        }

        await tx
          .update(branchOrderDetail)
          .set({
            remain: sql`${branchOrderDetail.remain} + ${body.quantityChange}`,
            updatedAt: sql`${utcTimestamp(now)}`,
          })
          .where(eq(branchOrderDetail.bodId, lot.bodId));
      }

      const [adjustment] = await tx
        .insert(stockAdjustment)
        .values({
          branchId,
          pId: body.pId,
          quantityChange: body.quantityChange,
          reason: body.reason,
          userId: actor.id,
        })
        .returning();

      await notificationService.checkMinStock(tx, branchId, body.pId);

      return { ...adjustment, onHand: onHandBefore + body.quantityChange };
    });
  },
};
