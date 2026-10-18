import { type Static, t } from "elysia";
import { ProductsModel } from "@/models/products.model";

// UnionEnum rather than t.Union over `.map(t.Literal)`: the mapped form
// widens to an array of one literal-union type, which Static resolves to
// `never` — fine for an input, but it breaks the response type below.
const sellerSortBy = t.UnionEnum(["revenue", "quantity"]);

// Every analytics query takes the same timeframe.
const from = t.Optional(
  t.String({
    format: "date-time",
    description:
      "Start of the timeframe, inclusive (ISO 8601 — include the offset, e.g. 2026-10-01T00:00:00+07:00). Defaults to 30 days before `to`.",
  }),
);
const to = t.Optional(
  t.String({
    format: "date-time",
    description: "End of the timeframe, exclusive (ISO 8601). Defaults to now.",
  }),
);
const categoryId = t.Optional(
  t.Numeric({
    minimum: 1,
    multipleOf: 1,
    description: "Only include products in this category.",
  }),
);

const SellerRankingQuery = t.Object({
  from,
  to,
  limit: t.Optional(
    t.Numeric({
      minimum: 1,
      maximum: 50,
      multipleOf: 1,
      description: "How many products to rank. Defaults to 10.",
    }),
  ),
  sortBy: t.Optional(
    t.UnionEnum(["revenue", "quantity"], {
      description:
        "What the ranking is by — `revenue` (quantity × the price each line actually sold at) or `quantity` (units sold). Defaults to `revenue`; the other metric breaks ties.",
    }),
  ),
  branchId: t.Optional(
    t.Numeric({
      minimum: 1,
      multipleOf: 1,
      description: "Only count sales made at this branch.",
    }),
  ),
  categoryId,
});

// The branch routes always rank the caller's own branch, so there's no
// branchId to pass.
const BranchSellerRankingQuery = t.Omit(SellerRankingQuery, ["branchId"]);

const DeadStockQuery = t.Object({
  from,
  to,
  limit: t.Optional(
    t.Numeric({
      minimum: 1,
      maximum: 100,
      multipleOf: 1,
      description: "Page size. Defaults to 20.",
    }),
  ),
  offset: t.Optional(
    t.Numeric({
      minimum: 0,
      multipleOf: 1,
      description: "How many products to skip. Defaults to 0.",
    }),
  ),
  categoryId,
});

const SellerRank = t.Object({
  /** 1-based position in this list — ties still get distinct ranks */
  rank: t.Integer(),
  pId: t.Integer(),
  productName: t.String(),
  barcode: t.String(),
  categories: t.Array(ProductsModel.categoryRef),
  totalRevenue: t.Integer(),
  totalQuantity: t.Integer(),
  /** completed customer orders that included this product */
  orderCount: t.Integer(),
});

const SellerRankingResponse = t.Object({
  // The timeframe actually used, with the defaults filled in, so a client
  // that sent neither bound can still label its chart.
  from: t.String({ format: "date-time" }),
  to: t.String({ format: "date-time" }),
  sortBy: sellerSortBy,
  result: t.Array(SellerRank),
});

const DeadStockItem = t.Object({
  pId: t.Integer(),
  productName: t.String(),
  barcode: t.String(),
  categories: t.Array(ProductsModel.categoryRef),
  /** units on hand at the branch, summed across its unexpired lots */
  onHandQuantity: t.Integer(),
  /** the branch's latest completed sale of it, at any time — null if never */
  lastSoldAt: t.Nullable(t.String({ format: "date-time" })),
});

const DeadStockResponse = t.Object({
  from: t.String({ format: "date-time" }),
  to: t.String({ format: "date-time" }),
  /** every dead-stock product, not just this page */
  totalCount: t.Integer(),
  result: t.Array(DeadStockItem),
});

export const AnalyticsModel = {
  sellerRankingQuery: SellerRankingQuery,
  branchSellerRankingQuery: BranchSellerRankingQuery,
  sellerRankingResponse: SellerRankingResponse,
  deadStockQuery: DeadStockQuery,
  deadStockResponse: DeadStockResponse,
};

export type SellerSortBy = Static<typeof sellerSortBy>;
export type SellerRankingQuery = Static<typeof SellerRankingQuery>;
export type BranchSellerRankingQuery = Static<typeof BranchSellerRankingQuery>;
export type SellerRank = Static<typeof SellerRank>;
export type SellerRankingResult = Static<typeof SellerRankingResponse>;
export type DeadStockQuery = Static<typeof DeadStockQuery>;
export type DeadStockItem = Static<typeof DeadStockItem>;
export type DeadStockResult = Static<typeof DeadStockResponse>;
