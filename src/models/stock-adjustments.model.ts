import { type Static, t } from "elysia";
import { createSelectSchema } from "drizzle-typebox";
import { stockAdjustment } from "@/db/schema";
import { AppError } from "@/utils/error";

const stockAdjustmentEntity = createSelectSchema(stockAdjustment);

export const StockAdjustmentsModel = {
  params: t.Object({ branchId: t.Numeric({ minimum: 1 }) }),
  createBody: t.Object({
    pId: t.Integer({ minimum: 1 }),
    // + found more than the system shows, − damaged/lost/miscounted. Zero
    // changes nothing, so it isn't an adjustment.
    quantityChange: t
      .Transform(t.Integer({ minimum: -10000, maximum: 10000 }))
      .Decode((quantity) => {
        if (quantity === 0) {
          throw new AppError("VALIDATION", {
            message: "quantityChange must not be zero",
          });
        }
        return quantity;
      })
      .Encode((quantity) => quantity),
    // Mandatory - an adjustment is a manual change to stock, and the reason
    // is what makes it auditable. Whitespace alone doesn't count.
    reason: t
      .Transform(t.String({ maxLength: 255 }))
      .Decode((reason) => {
        const trimmed = reason.trim();
        if (!trimmed) {
          throw new AppError("VALIDATION", { message: "reason is required" });
        }
        return trimmed;
      })
      .Encode((reason) => reason),
  }),
  createResponse: t.Composite([
    stockAdjustmentEntity,
    t.Object({
      // The product's on-hand total at this branch after the adjustment -
      // what branch inventory now shows for it.
      onHand: t.Number(),
    }),
  ]),
};

export type StockAdjustmentCreateBody = Static<
  typeof StockAdjustmentsModel.createBody
>;
export type StockAdjustmentCreateResponse = Static<
  typeof StockAdjustmentsModel.createResponse
>;
