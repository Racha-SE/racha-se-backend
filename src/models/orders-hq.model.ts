import { headOrderDetail, order } from "@/db/schema";
import { endOfBangkokDay } from "@/utils/date";
import { createSelectSchema } from "drizzle-typebox";
import { Static, t } from "elysia";

// headOrderDetail requires expiredDate up front (no separate "receive" step
// for HQ orders — approve/reject are the only transitions), so the supplier's
// expected expiry is captured at creation time, one line item per product.

const orderEntity = createSelectSchema(order);
const headOrderEntity = createSelectSchema(headOrderDetail);

const lineItem = t.Object({
  pId: t.Numeric({ minimum: 1 }),
  supplierId: t.Numeric({ minimum: 1 }),
  amount: t.Number({ minimum: 1, maximum: 10000 }),
  expiredDate: t
    .Transform(t.String({ format: "date-time" }))
    .Decode((date) => {
      // A label expiry is a calendar day, good through the end of it: snap to
      // 23:59:59.999 of that day in the offset the client sent (the user's
      // own time).
      const day = date.slice(0, 10);
      const expiry = endOfBangkokDay(day);
      return expiry.toISOString();
    })
    .Encode((date) => date),
  costPrice: t.Number({ minimum: 0, maximum: 100000 }),
});

const lineItemView = t.Omit(headOrderEntity, ["lotId"]);

export const OrdersHqModel = {
  createBody: t.Object({
    items: t.Array(lineItem, { minItems: 1, maxItems: 100 }),
  }),
  createBodyResponse: t.Composite([
    orderEntity,
    t.Object({ items: t.Array(lineItemView) }),
  ]),
};

export type OrdersHqCreateBody = Static<typeof OrdersHqModel.createBody>;
