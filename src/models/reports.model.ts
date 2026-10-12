import { t, Static } from "elysia";

export const ReportQueryModel = t.Object({
  startDate: t.String({ format: "date", description: "YYYY-MM-DD" }),
  endDate: t.String({ format: "date", description: "YYYY-MM-DD" }),
  format: t.Union([t.Literal("csv"), t.Literal("xlsx")]),
});

export const ReportResult = t.Object({
  productId: t.String(),
  productName: t.String(),
  quantity: t.Integer({ minimum: 0 }),
  salesQuantity: t.Integer({ minimum: 0 }),
  unitPrice: t.Number({ minimum: 0 }),
  unitCost: t.Number({ minimum: 0 }),
  totalRevenue: t.Number({ minimum: 0 }),
  totalCost: t.Number({ minimum: 0 }),
  totalProfit: t.Number(),
});

export const ReportModel = {
  query: ReportQueryModel,
  result: t.Array(ReportResult),
};

export type ReportResult = Static<typeof ReportResult>;
