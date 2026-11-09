import { headOrderDetail, order } from "@/db/schema";
import { AppError } from "@/utils";
import { createSelectSchema } from "drizzle-typebox";
import { Static, t } from "elysia";

// headOrderDetail requires expiredDate up front (no separate "receive" step
// for HQ orders — approve/reject are the only transitions), so the supplier's
// expected expiry is captured at creation time, one line item per product.

const orderEntity = createSelectSchema(order);
const headOrderEntity = createSelectSchema(headOrderDetail);

const lineItem = t.Object({
  pId: t.Number(),
  supplierId: t.Number(),
  amount: t.Number({ minimum: 1 }),
  expiredDate: t
    .Transform(t.String({ format: "date-time" }))
    .Decode((date) => {
      // A label expiry is a calendar day, good through the end of it: snap to
      // 00:00 of the next day in the offset the client sent (the user's own
      // time), so `expiredDate > now` stays true for the whole day.
      const [, day, offset] = date.match(
        /^(\d{4}-\d{2}-\d{2})T.*(Z|[+-]\d{2}:\d{2})$/i,
      )!;
      const expiry = new Date(
        new Date(`${day}T00:00:00${offset}`).getTime() + 24 * 60 * 60 * 1000,
      );
      if (expiry <= new Date())
        throw new AppError("VALIDATION", { message: "incorrect expired date" });
      return expiry.toISOString();
    })
    .Encode((date) => date),
  costPrice: t.Number({ minimum: 0 }),
});

const lineItemView = t.Omit(headOrderEntity, ["lotId"]);

export const OrdersHqModel = {
  createBody: t.Object({
    items: t.Array(lineItem, { minItems: 1 }),
  }),
  createBodyResponse: t.Composite([
    orderEntity,
    t.Object({ items: t.Array(lineItemView) }),
  ]),
};

export type OrdersHqCreateBody = Static<typeof OrdersHqModel.createBody>;
