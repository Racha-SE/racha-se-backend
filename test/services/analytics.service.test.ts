import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SellerRankingQuery } from "@/models/analytics.model";
import { analyticsService } from "@/services/analytics.service";
import { AppError } from "@/utils";
import {
  type AnalyticsFixture,
  setupAnalyticsFixture,
} from "../helpers/analytics";

let fixture: AnalyticsFixture;

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected the call to throw an AppError, but it resolved");
}

// A window nothing else in the shared test database falls into — every other
// suite's orders are stamped "now" — so best-seller lists only see what's
// seeded below. Worst-seller lists start from *every* active product, so
// those also filter on the fixture's category.
const FROM = new Date("2001-01-01T00:00:00.000Z");
const TO = new Date("2001-02-01T00:00:00.000Z");
const IN_WINDOW = new Date("2001-01-15T12:00:00.000Z");

let a: number; // 10 units, 200 revenue, over 2 orders (one split across lots)
let b: number; // 2 units, 300 revenue
let c: number; // 5 units, 200 revenue — ties `a` on revenue
let d: number; // active, never sold in the window
let e: number; // inactive, sold plenty — must never show up
let f: number; // 1 unit, 1000 revenue, sold at the *other* branch only

function window(query: Partial<SellerRankingQuery> = {}): SellerRankingQuery {
  return { from: FROM.toISOString(), to: TO.toISOString(), ...query };
}

function pIdsOf(result: { result: { pId: number }[] }) {
  return result.result.map((row) => row.pId);
}

beforeAll(async () => {
  fixture = await setupAnalyticsFixture("svcanalytics");

  // created in this order, so pId order is a < b < c < d < e < f
  a = await fixture.createProduct();
  b = await fixture.createProduct();
  c = await fixture.createProduct();
  d = await fixture.createProduct();
  e = await fixture.createProduct({ isActive: false });
  f = await fixture.createProduct();

  // `a`'s first order drew from two lots, so it's stored as two rows
  await fixture.recordSale({
    createdAt: IN_WINDOW,
    lines: [
      { pId: a, quantity: 3, unitPrice: 20 },
      { pId: a, quantity: 3, unitPrice: 20 },
      { pId: b, quantity: 2, unitPrice: 150 },
    ],
  });
  await fixture.recordSale({
    createdAt: IN_WINDOW,
    lines: [
      { pId: a, quantity: 4, unitPrice: 20 },
      { pId: c, quantity: 5, unitPrice: 40 },
    ],
  });
  await fixture.recordSale({
    createdAt: IN_WINDOW,
    lines: [{ pId: e, quantity: 100, unitPrice: 100 }],
  });
  await fixture.recordSale({
    createdAt: IN_WINDOW,
    branchId: fixture.otherBranchId,
    lines: [{ pId: f, quantity: 1, unitPrice: 1000 }],
  });

  // None of these count: unpaid, cancelled, and just either side of the
  // window (`to` is exclusive).
  await fixture.recordSale({
    createdAt: IN_WINDOW,
    status: "pending",
    lines: [{ pId: d, quantity: 50, unitPrice: 1000 }],
  });
  await fixture.recordSale({
    createdAt: IN_WINDOW,
    status: "rejected",
    lines: [{ pId: d, quantity: 50, unitPrice: 1000 }],
  });
  await fixture.recordSale({
    createdAt: new Date(FROM.getTime() - 1000),
    lines: [{ pId: d, quantity: 50, unitPrice: 1000 }],
  });
  await fixture.recordSale({
    createdAt: TO,
    lines: [{ pId: d, quantity: 50, unitPrice: 1000 }],
  });
});

afterAll(async () => {
  await fixture.cleanup();
});

describe("analyticsService.rankSellers — best", () => {
  test("ranks by revenue by default, quantity breaking the a/c tie", async () => {
    const result = await analyticsService.rankSellers("best", window());

    expect(result.sortBy).toBe("revenue");
    expect(pIdsOf(result)).toEqual([f, b, a, c]);
    expect(result.result.map((row) => row.rank)).toEqual([1, 2, 3, 4]);
  });

  test("sortBy=quantity ranks by units sold", async () => {
    const result = await analyticsService.rankSellers(
      "best",
      window({ sortBy: "quantity" }),
    );

    expect(result.sortBy).toBe("quantity");
    expect(pIdsOf(result)).toEqual([a, c, b, f]);
  });

  test("sums split lines and counts distinct orders", async () => {
    const result = await analyticsService.rankSellers("best", window());
    const row = result.result.find((item) => item.pId === a);

    expect(row).toMatchObject({
      totalRevenue: 200,
      totalQuantity: 10,
      orderCount: 2,
      categories: [expect.objectContaining({ categoryId: fixture.categoryId })],
    });
  });

  test("leaves out products with no completed sale in the window", async () => {
    const pIds = pIdsOf(await analyticsService.rankSellers("best", window()));

    expect(pIds).not.toContain(d); // pending, rejected, out-of-window only
    expect(pIds).not.toContain(e); // inactive
  });

  test("limit caps the list", async () => {
    const result = await analyticsService.rankSellers(
      "best",
      window({ limit: 2 }),
    );

    expect(pIdsOf(result)).toEqual([f, b]);
  });

  test("branchId only counts that branch's sales", async () => {
    const result = await analyticsService.rankSellers(
      "best",
      window({ branchId: fixture.branchId }),
    );

    expect(pIdsOf(result)).toEqual([b, a, c]);
  });
});

describe("analyticsService.rankSellers — worst", () => {
  test("starts with active products that sold nothing, then lowest revenue", async () => {
    const result = await analyticsService.rankSellers(
      "worst",
      window({ categoryId: fixture.categoryId }),
    );

    // c before a: same revenue, fewer units
    expect(pIdsOf(result)).toEqual([d, c, a, b, f]);
    expect(result.result[0]).toMatchObject({
      pId: d,
      totalRevenue: 0,
      totalQuantity: 0,
      orderCount: 0,
    });
  });

  test("never lists an inactive product", async () => {
    const pIds = pIdsOf(
      await analyticsService.rankSellers(
        "worst",
        window({ categoryId: fixture.categoryId, limit: 50 }),
      ),
    );

    expect(pIds).not.toContain(e);
  });

  test("sortBy=quantity ranks by fewest units", async () => {
    const result = await analyticsService.rankSellers(
      "worst",
      window({ categoryId: fixture.categoryId, sortBy: "quantity" }),
    );

    expect(pIdsOf(result)).toEqual([d, f, b, c, a]);
  });

  test("a product sold only at another branch counts as unsold for this one", async () => {
    const result = await analyticsService.rankSellers(
      "worst",
      window({ categoryId: fixture.categoryId, branchId: fixture.branchId }),
    );

    // d and f both sold nothing here — tied on both metrics, so pId decides
    expect(pIdsOf(result)).toEqual([d, f, c, a, b]);
  });
});

describe("analyticsService.rankSellers — timeframe", () => {
  test("defaults to the 30 days before now", async () => {
    const before = Date.now();
    const result = await analyticsService.rankSellers("best", {});
    const to = new Date(result.to).getTime();

    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(Date.now());
    expect(to - new Date(result.from).getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("echoes the timeframe it used", async () => {
    const result = await analyticsService.rankSellers("best", window());

    expect(result.from).toBe(FROM.toISOString());
    expect(result.to).toBe(TO.toISOString());
  });

  test("rejects from >= to with BAD_REQUEST", async () => {
    const error = await expectAppError(
      analyticsService.rankSellers("best", {
        from: TO.toISOString(),
        to: FROM.toISOString(),
      }),
    );

    expect(error.code).toBe("BAD_REQUEST");
  });

  test("rejects an unknown branchId with NOT_FOUND", async () => {
    const error = await expectAppError(
      analyticsService.rankSellers("best", window({ branchId: 2_000_000_000 })),
    );

    expect(error.code).toBe("NOT_FOUND");
  });
});
