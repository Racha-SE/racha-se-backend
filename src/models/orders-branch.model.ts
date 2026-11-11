import { type Static, t } from "elysia";
import { createSelectSchema } from "drizzle-typebox";
import { branchOrderDetail, order, branch, orderStatusEnum } from "@/db/schema";
import { AppError } from "@/utils/error";

const orderEntity = createSelectSchema(order);
const branchOrderDetailEntity = createSelectSchema(branchOrderDetail);
const branchEntity = createSelectSchema(branch);

const requestLineItem = t.Object({
  pId: t.Numeric({ minimum: 1 }),
  amount: t.Integer({ minimum: 1, maximum: 10000 }),
});

// What the branch counted off the truck for one approved line. receivedQty
// can be short of what HQ sent (lost or damaged in transit) but never over
// it - the service checks that against the line, since only it knows the
// approved amount. Zero is allowed: the whole line didn't arrive.
const receiveLineItem = t.Object({
  bodId: t.Integer({ minimum: 1 }),
  receivedQty: t.Integer({ minimum: 0, maximum: 10000 }),
  expiredDate: t
    .Transform(t.String({ format: "date-time" }))
    .Decode((date) => {
      if (new Date(date) < new Date())
        throw new AppError("VALIDATION", { message: "incorrect expired date" });
      return date;
    })
    .Encode((date) => date),
});

const lineItemView = t.Composite([
  t.Omit(branchOrderDetailEntity, ["lotId"]),
  t.Object({ availableAmount: t.Number() }),
]);

const BranchOrderView = t.Composite([
  orderEntity,
  t.Object({ items: t.Array(lineItemView) }),
]);

const BranchOrderViewWithoutAvailableAmount = t.Composite([
  orderEntity,
  t.Object({ items: t.Array(t.Omit(branchOrderDetailEntity, ["lotId"])) }),
]);

const BranchOrders = t.Composite([
  t.Object({
    orders: t.Array(
      t.Composite([
        BranchOrderViewWithoutAvailableAmount,
        t.Pick(branchEntity, ["branchId"]),
      ]),
    ),
  }),
  t.Object({
    limit: t.Number({ minimum: 1 }),
    offset: t.Number({ minimum: 0 }),
    totals: t.Number(),
  }),
]);

const orderStatusSchema = t.Union(
  orderStatusEnum.enumValues.map((value) => t.Literal(value)),
);

const GetBranchOrdersQuery = t.Partial(
  t.Object({
    status: orderStatusSchema,
    branchId: t.Numeric(),
    limit: t.Numeric(),
    offset: t.Numeric(),
  }),
);

/** The order row plus its line items - what create and approve both return. */
const orderWithItems = t.Composite([
  orderEntity,
  t.Object({
    items: t.Array(t.Omit(branchOrderDetailEntity, ["lotId"])),
  }),
]);

export const OrdersBranchModel = {
  params: t.Object({ lotId: t.Numeric() }),
  getBranchOrdersQuery: GetBranchOrdersQuery,
  createBody: t.Object({
    items: t
      .Transform(t.Array(requestLineItem, { minItems: 1, maxItems: 100 }))
      .Decode((items) => {
        const checkedItems = new Set<number>();
        for (const item of items) {
          if (checkedItems.has(item.pId)) {
            throw new AppError("VALIDATION", { message: "duplicate products" });
          }
          checkedItems.add(item.pId);
        }
        return items;
      })
      .Encode((items) => items),
  }),
  getBranchOrders: BranchOrders,
  getBranchOrderByLotId: BranchOrderView,
  detail: BranchOrderView,
  createResponse: orderWithItems,
  approveResponse: orderWithItems,
  rejectBody: t.Object({
    rejectReason: t.String({ minLength: 1, maxLength: 255 }),
  }),
  rejectResponse: orderWithItems,
  // Optional as a whole so a bare PATCH (no body) still signs for the
  // delivery exactly as HQ approved it. When `items` is sent it has to name
  // every line of the order once - the service enforces "every", this
  // enforces "once".
  receiveBody: t.Optional(
    t.Object({
      items: t.Optional(
        t
          .Transform(t.Array(receiveLineItem, { minItems: 1, maxItems: 100 }))
          .Decode((items) => {
            const checkedLines = new Set<number>();
            for (const item of items) {
              if (checkedLines.has(item.bodId)) {
                throw new AppError("VALIDATION", {
                  message: "duplicate order lines",
                });
              }
              checkedLines.add(item.bodId);
            }
            return items;
          })
          .Encode((items) => items),
      ),
    }),
  ),
  receiveResponse: t.Object({
    message: t.String(),
  }),
};

export type OrdersBranchQuery = Static<
  typeof OrdersBranchModel.getBranchOrdersQuery
>;
export type OrdersBranchGetResponse = Static<
  typeof OrdersBranchModel.getBranchOrders
>;
export type OrdersBranchGetByLotIdResponse = Static<
  typeof OrdersBranchModel.getBranchOrderByLotId
>;
export type OrdersBranchCreateBody = Static<
  typeof OrdersBranchModel.createBody
>;
export type OrdersBranchCreateResponse = Static<
  typeof OrdersBranchModel.createResponse
>;
export type OrdersBranchApproveResponse = Static<
  typeof OrdersBranchModel.approveResponse
>;
export type OrdersBranchRejectResponse = Static<
  typeof OrdersBranchModel.rejectResponse
>;
export type OrdersBranchReceiveBody = Static<
  typeof OrdersBranchModel.receiveBody
>;
