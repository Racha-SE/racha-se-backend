import { type Static, t } from "elysia";
import { createSelectSchema } from "drizzle-typebox";
import {
  branch,
  customerOrderDetail,
  order,
  orderStatusEnum,
} from "@/db/schema";
import { AppError } from "@/utils/error";

const orderEntity = createSelectSchema(order);
const customerOrderDetailEntity = createSelectSchema(customerOrderDetail);
const branchEntity = createSelectSchema(branch);

const requestLineItem = t.Object({
  pId: t.Number(),
  quantity: t.Integer({ minimum: 1 }),
});

const orderStatusSchema = t.Union(
  orderStatusEnum.enumValues.map((value) => t.Literal(value)),
);

// No branchId filter — list/getById are always scoped to the caller's own
// branch, there's no hq-wide view of customer orders.
const GetCustomerOrdersQuery = t.Partial(
  t.Object({
    status: orderStatusSchema,
    limit: t.Numeric(),
    offset: t.Numeric(),
  }),
);

// bodId is an internal reservation-tracking detail, not part of the public shape.
const lineItemView = t.Omit(customerOrderDetailEntity, ["lotId", "bodId"]);

const orderWithItems = t.Composite([
  orderEntity,
  t.Object({ items: t.Array(lineItemView) }),
]);

const CustomerOrders = t.Composite([
  t.Object({
    orders: t.Array(
      t.Composite([orderWithItems, t.Pick(branchEntity, ["branchId"])]),
    ),
  }),
  t.Object({
    limit: t.Number({ minimum: 1 }),
    offset: t.Number({ minimum: 0 }),
    totals: t.Number(),
  }),
]);

export const OrdersCustomerModel = {
  params: t.Object({ lotId: t.Numeric() }),
  getCustomerOrdersQuery: GetCustomerOrdersQuery,
  createBody: t.Object({
    paymentMethod: t.Union([t.Literal("cash"), t.Literal("qr")]),
    items: t
      .Transform(t.Array(requestLineItem, { minItems: 1 }))
      .Decode((items) => {
        const checkedItems = new Set<number>();
        for (const item of items) {
          if (checkedItems.has(item.pId)) {
            throw new AppError("VALIDATION");
          }
          checkedItems.add(item.pId);
        }
        return items;
      })
      .Encode((items) => items),
  }),
  getCustomerOrders: CustomerOrders,
  getCustomerOrderByLotId: orderWithItems,
  // paymentUrl is only present for paymentMethod "qr".
  createResponse: t.Composite([
    orderWithItems,
    t.Object({ paymentUrl: t.Optional(t.String()) }),
  ]),
  confirmPaymentResponse: orderWithItems,
  cancelResponse: orderWithItems,
};

export type OrdersCustomerQuery = Static<
  typeof OrdersCustomerModel.getCustomerOrdersQuery
>;
export type OrdersCustomerGetResponse = Static<
  typeof OrdersCustomerModel.getCustomerOrders
>;
export type OrdersCustomerGetByLotIdResponse = Static<
  typeof OrdersCustomerModel.getCustomerOrderByLotId
>;
export type OrdersCustomerCreateBody = Static<
  typeof OrdersCustomerModel.createBody
>;
export type OrdersCustomerCreateResponse = Static<
  typeof OrdersCustomerModel.createResponse
>;
export type OrdersCustomerConfirmPaymentResponse = Static<
  typeof OrdersCustomerModel.confirmPaymentResponse
>;
export type OrdersCustomerCancelResponse = Static<
  typeof OrdersCustomerModel.cancelResponse
>;
