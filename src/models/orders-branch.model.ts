import { type Static, t } from "elysia";
import { createSelectSchema } from "drizzle-typebox";
import { branchOrderDetail, order } from "@/db/schema";
import { AppError } from "@/utils/error";

const orderEntity = createSelectSchema(order);
const branchOrderDetailEntity = createSelectSchema(branchOrderDetail);

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

const LotDeduction = t.Object({
  hodId: t.Number(),
  bodId: t.Number(),
  amount: t.Integer({ minimum: 1 }),
});

export const OrdersBranchModel = {
  params: t.Object({ lotId: t.Numeric() }),
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
  detail: BranchOrderView,
  createResponse: t.Composite([
    orderEntity,
    t.Object({
      items: t.Array(t.Omit(branchOrderDetailEntity, ["lotId"])),
    }),
  ]),
};

export type OrdersBranchDetail = Static<typeof OrdersBranchModel.detail>;
export type OrdersBranchCreateBody = Static<
  typeof OrdersBranchModel.createBody
>;
export type OrdersBranchCreateResponse = Static<
  typeof OrdersBranchModel.createResponse
>;

export type LotDeduction = Static<typeof LotDeduction>;
