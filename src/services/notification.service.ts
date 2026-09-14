// Inventory alerts (US-2.9 HQ / BAC-52, US-3.5 branch / BAC-59): read out
// unresolved notification rows, joined with the product they're about, plus
// the detection logic that opens/resolves those rows.
//
// A row's scope is its branchId: null means HQ, a branch id scopes it to
// that branch. Both scopes share the same two alert types:
//
// - min_stock: checkMinStock(s) recomputes a product's current stock for a
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
//   scanAlerts() checks every product/scope pair in one batch (one select
//   for thresholds, one for current stock, one for already-open alerts, then
//   at most one update and one insert) rather than one round-trip per pair.
// - expire: checkExpiringLots opens an alert for any lot (HQ or branch) with
//   stock left whose expiredDate falls inside EXPIRE_WARNING_DAYS. There's
//   no order-flow event to hang this on (nothing "happens" when a lot merely
//   gets closer to expiring), so it only runs from scanAlerts() — meant to
//   be hit periodically (e.g. an external cron calling POST
//   /notifications/scan) until a real in-process scheduler exists. Same
//   batching approach: one select per scope for the candidate lots, then one
//   query to find which already have an open alert and one insert for the
//   rest.
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

/** Groups a (scope, product) pair into one map/set key — null branchId (HQ)
 * and a branch id can never collide since "hq" isn't a valid id. */
function scopeKey(branchId: number | null, pId: number): string {
  return `${branchId ?? "hq"}:${pId}`;
}

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

/**
 * Current stock for every (scope, pId) pair in `pairs`, in two queries total
 * regardless of how many pairs there are: one summing headOrderDetail for
 * every HQ-scoped pair, one summing branchOrderDetail (grouped by branch)
 * for every branch-scoped pair. Missing keys mean zero stock.
 */
async function currentStocks(
  dbOrTx: DbOrTx,
  pairs: { branchId: number | null; pId: number }[],
): Promise<Map<string, number>> {
  const now = new Date();
  const stockByKey = new Map<string, number>();

  const hqPIds = [
    ...new Set(
      pairs.filter(({ branchId }) => branchId === null).map(({ pId }) => pId),
    ),
  ];
  if (hqPIds.length > 0) {
    const rows = await dbOrTx
      .select({ pId: headOrderDetail.pId, stock: sum(headOrderDetail.remain) })
      .from(headOrderDetail)
      .innerJoin(order, eq(headOrderDetail.lotId, order.lotId))
      .where(
        and(
          inArray(headOrderDetail.pId, hqPIds),
          eq(order.orderType, "hq"),
          eq(order.status, "approved"),
          gt(headOrderDetail.expiredDate, now),
        ),
      )
      .groupBy(headOrderDetail.pId);

    for (const { pId, stock } of rows) {
      stockByKey.set(scopeKey(null, pId), Number(stock ?? 0));
    }
  }

  const branchPairs = pairs.filter(
    (pair): pair is { branchId: number; pId: number } => pair.branchId !== null,
  );
  if (branchPairs.length > 0) {
    const branchIds = [...new Set(branchPairs.map(({ branchId }) => branchId))];
    const branchPIds = [...new Set(branchPairs.map(({ pId }) => pId))];
    const rows = await dbOrTx
      .select({
        branchId: branchOrderDetail.branchId,
        pId: branchOrderDetail.pId,
        stock: sum(branchOrderDetail.remain),
      })
      .from(branchOrderDetail)
      .where(
        and(
          inArray(branchOrderDetail.branchId, branchIds),
          inArray(branchOrderDetail.pId, branchPIds),
        ),
      )
      .groupBy(branchOrderDetail.branchId, branchOrderDetail.pId);

    for (const { branchId, pId, stock } of rows) {
      stockByKey.set(scopeKey(branchId, pId), Number(stock ?? 0));
    }
  }

  return stockByKey;
}

/**
 * Recomputes current stock for every (scope, pId) pair in `pairs` and opens
 * or resolves that scope's min_stock alert to match: opens one if stock is
 * now under the scope's threshold and none is open yet, resolves the open
 * one once stock is back at/above it. No-ops if the alert state already
 * matches — an already-open alert's snapshot quantity is never rewritten.
 *
 * Runs in a fixed number of queries no matter how many pairs are passed: one
 * select for thresholds, one (see currentStocks) for stock, one for
 * already-open alerts, then at most one update and one insert.
 */
async function checkMinStocks(
  dbOrTx: DbOrTx,
  pairs: { branchId: number | null; pId: number }[],
): Promise<void> {
  if (pairs.length === 0) return;
  const now = new Date();

  const pIds = [...new Set(pairs.map(({ pId }) => pId))];

  const thresholdByPId = new Map(
    (
      await dbOrTx
        .select({
          pId: product.pId,
          minStockHq: product.minStockHq,
          minStockBranch: product.minStockBranch,
        })
        .from(product)
        .where(inArray(product.pId, pIds))
    ).map((row) => [row.pId, row]),
  );

  const stockByKey = await currentStocks(dbOrTx, pairs);

  const openAlertByKey = new Map(
    (
      await dbOrTx
        .select({
          notificationId: notification.notificationId,
          branchId: notification.branchId,
          pId: notification.pId,
        })
        .from(notification)
        .where(
          and(
            eq(notification.type, "min_stock"),
            inArray(notification.pId, pIds),
            eq(notification.isResolved, false),
          ),
        )
    ).map((row) => [scopeKey(row.branchId, row.pId), row.notificationId]),
  );

  const toResolve: number[] = [];
  const toOpen: {
    type: "min_stock";
    branchId: number | null;
    pId: number;
    quantity: number;
  }[] = [];
  const seen = new Set<string>();

  for (const { branchId, pId } of pairs) {
    const key = scopeKey(branchId, pId);
    if (seen.has(key)) continue; // pairs can repeat the same (scope, pId)
    seen.add(key);

    const target = thresholdByPId.get(pId);
    if (!target) continue;

    const threshold =
      branchId === null ? target.minStockHq : target.minStockBranch;
    const stock = stockByKey.get(key) ?? 0;
    const existingId = openAlertByKey.get(key);

    if (stock < threshold) {
      if (!existingId)
        toOpen.push({ type: "min_stock", branchId, pId, quantity: stock });
    } else if (existingId) {
      toResolve.push(existingId);
    }
  }

  if (toResolve.length > 0) {
    await dbOrTx
      .update(notification)
      .set({ isResolved: true, resolvedAt: now })
      .where(inArray(notification.notificationId, toResolve));
  }
  if (toOpen.length > 0) {
    await dbOrTx.insert(notification).values(toOpen);
  }
}

/** Single-pair convenience wrapper around checkMinStocks, for callers (like
 * ordersBranchService.create) that only ever have one product/scope to
 * recheck at a time. */
async function checkMinStock(
  dbOrTx: DbOrTx,
  branchId: number | null,
  pId: number,
): Promise<void> {
  await checkMinStocks(dbOrTx, [{ branchId, pId }]);
}

/**
 * Opens an expire alert for every lot in `lots` whose stock hasn't already
 * got one open, in two queries total regardless of how many lots are
 * passed: one to find which (lotId, pId) pairs already have an open expire
 * alert, one batch insert for the rest. order.lotId is a single serial
 * shared by HQ and branch orders alike, so a (lotId, pId) pair alone already
 * identifies the exact detail row - no need to also match on branchId.
 * Returns how many new alerts were opened.
 */
async function openExpireAlerts(
  dbOrTx: DbOrTx,
  lots: {
    branchId: number | null;
    lotId: number;
    pId: number;
    remain: number;
    expiredDate: Date | null;
  }[],
): Promise<number> {
  const candidates = lots.filter(
    (lot): lot is typeof lot & { expiredDate: Date } =>
      lot.expiredDate !== null,
  );
  if (candidates.length === 0) return 0;

  const lotIds = [...new Set(candidates.map(({ lotId }) => lotId))];

  const existingKeys = new Set(
    (
      await dbOrTx
        .select({ lotId: notification.lotId, pId: notification.pId })
        .from(notification)
        .where(
          and(
            eq(notification.type, "expire"),
            inArray(notification.lotId, lotIds),
            eq(notification.isResolved, false),
          ),
        )
    ).map(({ lotId, pId }) => `${lotId}:${pId}`),
  );

  const toInsert = candidates.filter(
    (lot) => !existingKeys.has(`${lot.lotId}:${lot.pId}`),
  );
  if (toInsert.length === 0) return 0;

  await dbOrTx.insert(notification).values(
    toInsert.map((lot) => ({
      type: "expire" as const,
      branchId: lot.branchId,
      pId: lot.pId,
      lotId: lot.lotId,
      quantity: lot.remain,
      expiredDate: lot.expiredDate,
    })),
  );

  return toInsert.length;
}

/**
 * Finds every HQ lot (branchId null) and every branch lot with stock left
 * whose expiredDate lands inside the warning window, and opens an expire
 * alert for whichever of those don't already have one open. Never resolves
 * expire alerts — nothing in this codebase clears a lot's remaining stock
 * except the branch-draw path, which isn't an "it's no longer expiring"
 * event.
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

  const hqOpened = await openExpireAlerts(
    dbOrTx,
    hqLots.map((lot) => ({ ...lot, branchId: null })),
  );

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

  const branchOpened = await openExpireAlerts(dbOrTx, branchLots);

  return { hqOpened, branchOpened };
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
   * status" from US-2.9/US-3.5, since nothing schedules this yet. Batched
   * throughout: the min_stock pass is one call to checkMinStocks with every
   * product/scope pair, not one call per pair.
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

    await checkMinStocks(db, [
      ...activeProductIds.map((pId) => ({ branchId: null, pId })),
      ...branchProductPairs,
    ]);

    const { hqOpened, branchOpened } = await checkExpiringLots(db);

    return {
      hqMinStockChecked: activeProductIds.length,
      branchMinStockChecked: branchProductPairs.length,
      hqExpireOpened: hqOpened,
      branchExpireOpened: branchOpened,
    };
  },
};
