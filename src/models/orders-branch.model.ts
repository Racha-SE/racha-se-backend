import { type Static, t } from "elysia";
import { createSelectSchema } from "drizzle-typebox";
import { branchOrderDetail, order, branch, orderStatusEnum } from "@/db/schema";
import { AppError } from "@/utils/error";

const orderEntity = createSelectSchema(order);
const branchOrderDetailEntity = createSelectSchema(branchOrderDetail);
const branchEntity = createSelectSchema(branch);

const requestLineItem = t.Object({
  pId: t.Number(),
  amount: t.Integer({ minimum: 1 }),
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

const LotDeduction = t.Object({
  hodId: t.Number(),
  amount: t.Integer({ minimum: 1 }),
});

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

export const OrdersBranchModel = {
  params: t.Object({ lotId: t.Numeric() }),
  getBranchOrdersQuery: GetBranchOrdersQuery,
  createBody: t.Object({
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
  getBranchOrders: BranchOrders,
  getBranchOrderByLotId: BranchOrderView,
  createResponse: t.Composite([
    orderEntity,
    t.Object({
      items: t.Array(t.Omit(branchOrderDetailEntity, ["lotId"])),
    }),
  ]),
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

export type LotDeduction = Static<typeof LotDeduction>;
