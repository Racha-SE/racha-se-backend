import { type Static, t } from "elysia";
import { createSelectSchema } from "drizzle-typebox";
import { notification } from "@/db/schema";

const entity = createSelectSchema(notification);

// A raised alert, joined with the product fields needed to display it
// (the notification row itself only stores pId, not the product's name/barcode).
const alertEntry = t.Composite([
  entity,
  t.Object({
    productName: t.String(),
    barcode: t.String(),
  }),
]);

export const NotificationModel = {
  entity,
  alertEntry,
  alertListResult: t.Object({
    result: t.Array(alertEntry),
  }),
  branchParams: t.Object({ branchId: t.Numeric({ minimum: 1 }) }),
  scanResult: t.Object({
    hqMinStockChecked: t.Number(),
    branchMinStockChecked: t.Number(),
    hqExpireOpened: t.Number(),
    branchExpireOpened: t.Number(),
  }),
};

export type NotificationAlertEntry = Static<
  typeof NotificationModel.alertEntry
>;
export type NotificationScanResult = Static<
  typeof NotificationModel.scanResult
>;
