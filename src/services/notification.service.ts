// HQ inventory alert queries: read out unresolved notification rows scoped to
// HQ (branchId null), joined with the product they're about. Nothing writes
// to the notification table yet — creating/resolving alerts depends on the
// order flows that should trigger them (ordersHqService.create(),
// ordersBranchService.receive(), and the not-yet-built customer order
// service), which are themselves still stubs. Once that real logic is
// written, wire in:
//
// - ordersHqService.create() (stock added into HQ): resolve the HQ min_stock
//   notification for each product in the order, if one is open.
// - ordersBranchService.receive() (HQ stock deducted, branch stock
//   incremented): resolve the branch's min_stock notification for each
//   product received; then, per product, if the HQ lot(s) remaining stock
//   drops below product.minStockHq after the deduction, open/keep an HQ
//   min_stock notification.
// - customer order creation (not yet scaffolded): after decrementing branch
//   stock, if it drops below product.minStockBranch, open/keep a branch
//   min_stock notification.
// - expire notifications: not created by any of the above — needs a
//   scheduled job scanning headOrderDetail/branchOrderDetail for lots
//   nearing expiredDate (not yet built).
//
// The branch-scoped list queries below remain stubs for the same reason —
// implementing them is a separate task from the HQ queries built here.
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { notification, notificationTypeEnum, product } from "@/db/schema";
import type { NotificationAlertEntry } from "@/models/notification.model";

type NotificationType = (typeof notificationTypeEnum.enumValues)[number];

async function listHqAlerts(
  type: NotificationType,
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
        isNull(notification.branchId),
        eq(notification.isResolved, false),
      ),
    )
    .orderBy(
      type === "expire"
        ? asc(notification.expiredDate)
        : desc(notification.createdAt),
    );
}

export const notificationService = {
  listHqExpire(): Promise<NotificationAlertEntry[]> {
    return listHqAlerts("expire");
  },

  listHqMinStock(): Promise<NotificationAlertEntry[]> {
    return listHqAlerts("min_stock");
  },

  listBranchExpire(): Promise<null> {
    return Promise.resolve(null);
  },

  listBranchMinStock(): Promise<null> {
    return Promise.resolve(null);
  },
};
