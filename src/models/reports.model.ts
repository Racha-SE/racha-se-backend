import { t, Static } from "elysia";

export const ReportQueryModel = t.Object({
  startDate: t.String({ format: "date", description: "YYYY-MM-DD" }),
  endDate: t.String({ format: "date", description: "YYYY-MM-DD" }),
  format: t.Union([t.Literal("csv"), t.Literal("xlsx"), t.Literal("json")]),
  branchId: t.Optional(t.Numeric({ minimum: 1 })),
});

export const ReportResult = t.Object({
  productId: t.Integer(),
  productName: t.String(),
  categories: t.Array(t.String()),
  salesQuantity: t.Integer({ minimum: 0 }),
  revenue: t.Number({ minimum: 0 }),
  cost: t.Number({ minimum: 0 }),
  profit: t.Number(),
});

export type ReportResult = Static<typeof ReportResult>;
