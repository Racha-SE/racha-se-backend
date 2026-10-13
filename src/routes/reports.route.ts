import ExcelJS from "exceljs";
import { Parser } from "json2csv";
import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { reportsService } from "@/services/reports.service";
import { ReportQueryModel } from "@/models/reports.model";
import { type ReportResult } from "@/models/reports.model";
import { type UserType, tErrorResponse, toActor } from "@/utils";

// HQ and Branch accounts can view reports.
const READ_REPORT_TYPES: UserType[] = ["hq", "branch"];

function convertToCSV(salesData: ReportResult[]) {
  const csv = new Parser({
    fields: [
      { label: "Product ID", value: "productId" },
      { label: "Product Name", value: "productName" },
      {
        label: "Categories",
        value: (row: ReportResult) => row.categories.join(", "),
      },
      { label: "Quantity", value: "quantity" },
      { label: "Sales Quantity", value: "salesQuantity" },
      { label: "Total Revenue", value: "totalRevenue" },
      { label: "Total Cost", value: "totalCost" },
      { label: "Total Profit", value: "totalProfit" },
    ],
  }).parse(salesData);

  return csv;
}

async function convertToXLSX(salesData: ReportResult[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sales Report");

  ws.columns = [
    { header: "Product ID", key: "productId", width: 15 },
    { header: "Product Name", key: "productName", width: 30 },
    { header: "Categories", key: "categories", width: 30 },
    { header: "Quantity", key: "quantity", width: 10 },
    { header: "Sales Quantity", key: "salesQuantity", width: 15 },
    { header: "Total Revenue", key: "totalRevenue", width: 20 },
    { header: "Total Cost", key: "totalCost", width: 20 },
    { header: "Total Profit", key: "totalProfit", width: 20 },
  ];

  salesData.forEach((data) => {
    ws.addRow({ ...data, categories: data.categories.join(", ") });
  });

  const buf = await wb.xlsx.writeBuffer();
  return buf;
}

export const reportsRoute = new Elysia({ prefix: "/reports" })
  .use(authPlugin)
  .get(
    "/",
    async ({ user, query }) => {
      const actor = toActor(user);
      const { startDate, endDate, format, branchId } = query;
      const reportData = await reportsService.getSalesAndProfitReport(
        actor,
        startDate,
        endDate,
        branchId,
      );

      switch (format) {
        case "csv": {
          const csvData = convertToCSV(reportData);
          return new Response(csvData, {
            headers: {
              "Content-Type": "text/csv",
              "Content-Disposition": `attachment; filename="sales_report_${startDate}_to_${endDate}.csv"`,
            },
          });
        }
        case "xlsx": {
          const xlsxData = await convertToXLSX(reportData);
          return new Response(xlsxData, {
            headers: {
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "Content-Disposition": `attachment; filename="sales_report_${startDate}_to_${endDate}.xlsx"`,
            },
          });
        }
      }
    },
    {
      auth: READ_REPORT_TYPES,
      query: ReportQueryModel,
      response: {
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "List reports (searchable)",
        description:
          "Search/select an existing report to view. Filter by `search` (name) and/or `isActive`.",
        tags: ["Reports"],
        responses: {
          200: {
            description: "Get Products Sales Report",
            content: {
              "text/csv": {
                schema: { type: "string" },
              },
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
                {
                  schema: { type: "string", format: "binary" },
                },
            },
          },
        },
      },
    },
  );
