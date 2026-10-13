import { t, Static } from "elysia";

export const ReportQueryModel = t.Object({
  startDate: t.String({ format: "date", description: "YYYY-MM-DD" }),
  endDate: t.String({ format: "date", description: "YYYY-MM-DD" }),
  format: t.Union([t.Literal("csv"), t.Literal("xlsx")]),
  branchId: t.Optional(t.Integer({ minimum: 1 })),
});

export const ReportResult = t.Object({
  productId: t.Integer(),
  productName: t.String(),
  categories: t.Array(t.String()),
  quantity: t.Integer({ minimum: 0 }),
  salesQuantity: t.Integer({ minimum: 0 }),
  totalRevenue: t.Number({ minimum: 0 }),
  totalCost: t.Number({ minimum: 0 }),
  totalProfit: t.Number(),
});

export const ReportModel = {
  query: ReportQueryModel,
  result: t.Array(ReportResult),
};

export type ReportResult = Static<typeof ReportResult>;
