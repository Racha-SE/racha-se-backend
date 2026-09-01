import { type Static, t } from "elysia";
import { createSelectSchema } from "drizzle-typebox";
import { branchOrderDetail, order } from "@/db/schema";

const orderEntity = createSelectSchema(order);
const branchOrderDetailEntity = createSelectSchema(branchOrderDetail);

const requestLineItem = t.Object({
  pId: t.Number(),
  amount: t.Number({ minimum: 1 }),
});

const lineItemView = t.Composite([
  t.Omit(branchOrderDetailEntity, ["lotId"]),
  t.Object({ availableAmount: t.Number() }),
]);

const BranchOrderView = t.Composite([
  orderEntity,
  t.Object({ items: t.Array(lineItemView) }),
]);

export const OrdersBranchModel = {
  params: t.Object({ lotId: t.Numeric() }),
  createBody: t.Object({
    items: t.Array(requestLineItem, { minItems: 1 }),
  }),
  detail: BranchOrderView,
  createBodyResponse: BranchOrderView,
};

export type OrdersBranchDetail = Static<typeof OrdersBranchModel.detail>;
export type OrdersBranchCreateBody = Static<
  typeof OrdersBranchModel.createBody
>;
