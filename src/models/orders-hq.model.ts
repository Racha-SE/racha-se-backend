import { t } from "elysia";

// headOrderDetail requires expiredDate up front (no separate "receive" step
// for HQ orders — approve/reject are the only transitions), so the supplier's
// expected expiry is captured at creation time, one line item per product.
const lineItem = t.Object({
  pId: t.Number(),
  supplierId: t.Number(),
  amount: t.Number({ minimum: 1 }),
  expiredDate: t.String({ format: "date-time" }),
  basePrice: t.Number({ minimum: 0 }),
  costPrice: t.Number({ minimum: 0 }),
});

export const OrdersHqModel = {
  createBody: t.Object({
    items: t.Array(lineItem, { minItems: 1 }),
  }),
};
