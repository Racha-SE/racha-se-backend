// Inventory alerts (US-2.9 HQ / BAC-52, US-3.5 branch / BAC-59): read out
// unresolved notification rows, joined with the product they're about, plus
// the detection logic that opens/resolves those rows.
//
// A row's scope is its branchId: null means HQ, a branch id scopes it to
// that branch. Both scopes share the same two alert types:
//
// - min_stock: checkMinStock recomputes a product's current stock for a
//   scope and opens an alert if it's under the scope's threshold
//   (product.minStockHq for HQ, product.minStockBranch for a branch), or
//   resolves the open one once stock is back at/above it.
//   - HQ stock is the total remaining across approved, not-yet-expired
//     headOrderDetail lots — the same "drawable stock" definition
//     ordersBranchService.create draws against.
//   - A branch's stock is the total remaining across its
//     branchOrderDetail rows. There's no consumption path yet (no customer
//     orders), so branch stock only ever moves up via create() — a low-stock
//     alert here means a branch's incoming stock still hasn't caught up to
//     its configured minimum.
//   checkMinStock is wired into ordersBranchService.create() (the one code
//   path that actually moves both HQ and branch stock today: it deducts
//   headOrderDetail.remain and inserts branchOrderDetail rows in the same
//   transaction), and also runs for every product/scope from scanAlerts()
//   below, so e.g. a minStockHq edit that pushes stock under the new
//   threshold without anyone touching it still gets caught next scan.
// - expire: checkExpiringLots opens an alert for any lot (HQ or branch) with
//   stock left whose expiredDate falls inside EXPIRE_WARNING_DAYS. There's
//   no order-flow event to hang this on (nothing "happens" when a lot merely
//   gets closer to expiring), so it only runs from scanAlerts() — meant to
//   be hit periodically (e.g. an external cron calling POST
//   /notifications/scan) until a real in-process scheduler exists.
//
// Resolving/creating alerts from the write side beyond the above — HQ stock
// arriving (ordersHqService.create), a branch's own receive step, customer
// orders consuming branch stock — depends on order flows that are
// themselves still stubs; out of scope here.
import { and, asc, desc, eq, gt, inArray, isNull, lte, sum } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branchOrderDetail,
  headOrderDetail,
  notification,
  notificationTypeEnum,
  order,
  product,
} from "@/db/schema";
import type { NotificationAlertEntry } from "@/models/notification.model";
import { assertBranchScope, type ScopedActor } from "@/utils/hierarchy";

type NotificationType = (typeof notificationTypeEnum.enumValues)[number];

// Accepts either the top-level `db` or a transaction handed in by a caller
// (ordersBranchService.create runs this inside its own tx so the stock
// change and the alert it can trigger commit together).
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// US-2.9 / US-3.5's "configured expiration warning period" — fixed
// system-wide (US-3.5 spells it out as 7 days) since there's no per-product
// override column yet.
const EXPIRE_WARNING_DAYS = 7;

async function listAlerts(
  type: NotificationType,
  branchId: number | null,
): Promise<NotificationAlertEntry[]> {
  return await db
    .select({
      notificationId: notification.notificationId,
      type: notification.type,
      branchId: notification.branchId,
      pId: notification.pId,
      quantity: notification.quantity,
      lotId: notification.lotId,
      expiredDate: notification.expiredDate,
      isResolved: notification.isResolved,
      resolvedAt: notification.resolvedAt,
      createdAt: notification.createdAt,
      productName: product.name,
      barcode: product.barcode,
    })
    .from(notification)
    .innerJoin(product, eq(notification.pId, product.pId))
    .where(
      and(
        eq(notification.type, type),
        branchId === null
          ? isNull(notification.branchId)
          : eq(notification.branchId, branchId),
        eq(notification.isResolved, false),
      ),
    )
    .orderBy(
      type === "expire"
        ? asc(notification.expiredDate)
        : desc(notification.createdAt),
    );
}

async function currentStock(
  dbOrTx: DbOrTx,
  branchId: number | null,
  pId: number,
): Promise<number> {
  if (branchId === null) {
    const now = new Date();
    const [{ stock }] = await dbOrTx
      .select({ stock: sum(headOrderDetail.remain) })
      .from(headOrderDetail)
      .innerJoin(order, eq(headOrderDetail.lotId, order.lotId))
      .where(
        and(
          eq(headOrderDetail.pId, pId),
          eq(order.orderType, "hq"),
          eq(order.status, "approved"),
          gt(headOrderDetail.expiredDate, now),
        ),
      );
    return Number(stock ?? 0);
  }

  const [{ stock }] = await dbOrTx
    .select({ stock: sum(branchOrderDetail.remain) })
    .from(branchOrderDetail)
    .where(
      and(
        eq(branchOrderDetail.pId, pId),
        eq(branchOrderDetail.branchId, branchId),
      ),
    );
  return Number(stock ?? 0);
}

/**
 * Recomputes product `pId`'s current stock for the given scope (`branchId`
 * null = HQ) and opens or resolves that scope's min_stock alert to match:
 * opens one if stock is now under the scope's threshold and none is open
 * yet, resolves the open one once stock is back at/above it. No-ops if the
 * alert state already matches — an already-open alert's snapshot quantity
 * is never rewritten.
 */
async function checkMinStock(
  dbOrTx: DbOrTx,
  branchId: number | null,
  pId: number,
): Promise<void> {
  const now = new Date();

  const [target] = await dbOrTx
    .select({
      minStockHq: product.minStockHq,
      minStockBranch: product.minStockBranch,
    })
    .from(product)
    .where(eq(product.pId, pId));
  if (!target) return;

  const threshold =
    branchId === null ? target.minStockHq : target.minStockBranch;
  const stock = await currentStock(dbOrTx, branchId, pId);

  const [openAlert] = await dbOrTx
    .select({ notificationId: notification.notificationId })
    .from(notification)
    .where(
      and(
        eq(notification.type, "min_stock"),
        branchId === null
          ? isNull(notification.branchId)
          : eq(notification.branchId, branchId),
        eq(notification.pId, pId),
        eq(notification.isResolved, false),
      ),
    );

  if (stock < threshold) {
    if (!openAlert) {
      await dbOrTx.insert(notification).values({
        type: "min_stock",
        branchId,
        pId,
        quantity: stock,
      });
    }
  } else if (openAlert) {
    await dbOrTx
      .update(notification)
      .set({ isResolved: true, resolvedAt: now })
      .where(eq(notification.notificationId, openAlert.notificationId));
  }
}

/**
 * Opens an expire alert for every HQ lot (branchId null) and every branch
 * lot with stock left whose expiredDate lands inside the warning window and
 * doesn't already have one open. Never resolves expire alerts — nothing in
 * this codebase clears a lot's remaining stock except the branch-draw path,
 * which isn't an "it's no longer expiring" event.
 */
async function checkExpiringLots(
  dbOrTx: DbOrTx,
): Promise<{ hqOpened: number; branchOpened: number }> {
  const now = new Date();
  const warningCutoff = new Date(
    now.getTime() + EXPIRE_WARNING_DAYS * 24 * 60 * 60 * 1000,
  );
  const inWindow = and(
    gt(headOrderDetail.expiredDate, now),
    lte(headOrderDetail.expiredDate, warningCutoff),
  );

  const hqLots = await dbOrTx
    .select({
      lotId: headOrderDetail.lotId,
      pId: headOrderDetail.pId,
      remain: headOrderDetail.remain,
      expiredDate: headOrderDetail.expiredDate,
    })
    .from(headOrderDetail)
    .innerJoin(order, eq(headOrderDetail.lotId, order.lotId))
    .where(
      and(
        eq(order.orderType, "hq"),
        eq(order.status, "approved"),
        gt(headOrderDetail.remain, 0),
        inWindow,
      ),
    );

  let hqOpened = 0;
  for (const lot of hqLots) {
    const opened = await openExpireAlert(dbOrTx, null, lot);
    if (opened) hqOpened++;
  }

  const branchLots = await dbOrTx
    .select({
      lotId: branchOrderDetail.lotId,
      pId: branchOrderDetail.pId,
      branchId: branchOrderDetail.branchId,
      remain: branchOrderDetail.remain,
      expiredDate: branchOrderDetail.expiredDate,
    })
    .from(branchOrderDetail)
    .where(
      and(
        gt(branchOrderDetail.remain, 0),
        gt(branchOrderDetail.expiredDate, now),
        lte(branchOrderDetail.expiredDate, warningCutoff),
      ),
    );

  let branchOpened = 0;
  for (const lot of branchLots) {
    const opened = await openExpireAlert(dbOrTx, lot.branchId, lot);
    if (opened) branchOpened++;
  }

  return { hqOpened, branchOpened };
}

async function openExpireAlert(
  dbOrTx: DbOrTx,
  branchId: number | null,
  lot: {
    lotId: number;
    pId: number;
    remain: number;
    expiredDate: Date | null;
  },
): Promise<boolean> {
  if (!lot.expiredDate) return false;

  const [existing] = await dbOrTx
    .select({ notificationId: notification.notificationId })
    .from(notification)
    .where(
      and(
        eq(notification.type, "expire"),
        branchId === null
          ? isNull(notification.branchId)
          : eq(notification.branchId, branchId),
        eq(notification.pId, lot.pId),
        eq(notification.lotId, lot.lotId),
        eq(notification.isResolved, false),
      ),
    );
  if (existing) return false;

  await dbOrTx.insert(notification).values({
    type: "expire",
    branchId,
    pId: lot.pId,
    lotId: lot.lotId,
    quantity: lot.remain,
    expiredDate: lot.expiredDate,
  });
  return true;
}

export const notificationService = {
  listHqExpire(): Promise<NotificationAlertEntry[]> {
    return listAlerts("expire", null);
  },

  listHqMinStock(): Promise<NotificationAlertEntry[]> {
    return listAlerts("min_stock", null);
  },

  listBranchExpire(
    actor: ScopedActor,
    branchId: number,
  ): Promise<NotificationAlertEntry[]> {
    assertBranchScope(actor, branchId);
    return listAlerts("expire", branchId);
  },

  listBranchMinStock(
    actor: ScopedActor,
    branchId: number,
  ): Promise<NotificationAlertEntry[]> {
    assertBranchScope(actor, branchId);
    return listAlerts("min_stock", branchId);
  },

  checkMinStock,

  /**
   * Runs min_stock detection for every active product (HQ, plus every
   * branch that has ever had stock moved into it) and expire detection for
   * every HQ/branch lot, in one pass — "the system detects the expiration
   * status" from US-2.9/US-3.5, since nothing schedules this yet.
   */
  async scanAlerts(): Promise<{
    hqMinStockChecked: number;
    branchMinStockChecked: number;
    hqExpireOpened: number;
    branchExpireOpened: number;
  }> {
    const activeProducts = await db
      .select({ pId: product.pId })
      .from(product)
      .where(eq(product.isActive, true));
    const activeProductIds = activeProducts.map((p) => p.pId);

    for (const pId of activeProductIds) {
      await checkMinStock(db, null, pId);
    }

    const branchProductPairs =
      activeProductIds.length > 0
        ? await db
            .selectDistinct({
              branchId: branchOrderDetail.branchId,
              pId: branchOrderDetail.pId,
            })
            .from(branchOrderDetail)
            .where(inArray(branchOrderDetail.pId, activeProductIds))
        : [];

    for (const pair of branchProductPairs) {
      await checkMinStock(db, pair.branchId, pair.pId);
    }

    const { hqOpened, branchOpened } = await checkExpiringLots(db);

    return {
      hqMinStockChecked: activeProductIds.length,
      branchMinStockChecked: branchProductPairs.length,
      hqExpireOpened: hqOpened,
      branchExpireOpened: branchOpened,
    };
  },
};
