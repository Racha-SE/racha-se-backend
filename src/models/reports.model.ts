import { t } from "elysia";

export interface SalesReportRow {
  date: string;
  branchName: string;
  orderId: number;
  productName: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  totalSales: number;
  totalProfit: number;
}

export const ReportQueryModel = t.Object({
  startDate: t.String({ format: "date", description: "YYYY-MM-DD" }),
  endDate: t.String({ format: "date", description: "YYYY-MM-DD" }),
  format: t.Union([t.Literal("csv"), t.Literal("xlsx")]),
});
