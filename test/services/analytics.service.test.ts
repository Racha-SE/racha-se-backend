import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  DeadStockQuery,
  DeadStockResult,
  SellerRankingQuery,
} from "@/models/analytics.model";
import { analyticsService } from "@/services/analytics.service";
import { AppError, type ScopedActor } from "@/utils";
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

function branchActor(branchId: number | null): ScopedActor {
  return { id: "analytics-test-actor", userType: "branch", branchId };
}

describe("analyticsService.rankBranchSellers", () => {
  test("ranks only the caller's own branch", async () => {
    const result = await analyticsService.rankBranchSellers(
      branchActor(fixture.branchId),
      window(),
    );

    // f sold only at the other branch
    expect(pIdsOf(result)).toEqual([b, a, c]);
  });

  test("rejects an actor without a branch with FORBIDDEN", async () => {
    const error = await expectAppError(
      analyticsService.rankBranchSellers(branchActor(null), window()),
    );

    expect(error.code).toBe("FORBIDDEN");
  });
});

describe("analyticsService.getDeadStock", () => {
  // Its own fixture (own branches and category), so the stocked products
  // here never show up in the worst-seller lists above, and its own window
  // (2002) so its sales never show up in the best-seller lists either.
  let deadStock: AnalyticsFixture;
  let actor: ScopedActor;

  const DS_FROM = new Date("2002-01-01T00:00:00.000Z");
  const DS_TO = new Date("2002-02-01T00:00:00.000Z");
  const DS_IN_WINDOW = new Date("2002-01-15T12:00:00.000Z");
  const DS_BEFORE_WINDOW = new Date("2001-12-20T08:30:00.000Z");

  let g: number; // 40 on hand, never sold
  let h: number; // 10 on hand, sold in the window
  let i: number; // 25 on hand, sold only before the window
  let j: number; // 5 on hand, sold in the window at the *other* branch only
  let k: number; // lot with nothing left
  let l: number; // on hand, but the lot has expired
  let m: number; // lot whose branch order is still pending
  let n: number; // inactive product, on hand, unsold
  let o: number; // on hand at the other branch only
  let p: number; // 15 + 10 on hand over two lots; its only sale is pending

  function deadStockWindow(
    query: Partial<DeadStockQuery> = {},
  ): DeadStockQuery {
    return { from: DS_FROM.toISOString(), to: DS_TO.toISOString(), ...query };
  }

  function pIdsOfDeadStock(result: DeadStockResult) {
    return result.result.map((row) => row.pId);
  }

  beforeAll(async () => {
    deadStock = await setupAnalyticsFixture("svcdeadstock");
    actor = branchActor(deadStock.branchId);

    // created in this order, so pId order is g < h < ... < p
    g = await deadStock.createProduct();
    h = await deadStock.createProduct();
    i = await deadStock.createProduct();
    j = await deadStock.createProduct();
    k = await deadStock.createProduct();
    l = await deadStock.createProduct();
    m = await deadStock.createProduct();
    n = await deadStock.createProduct({ isActive: false });
    o = await deadStock.createProduct();
    p = await deadStock.createProduct();

    await deadStock.createBranchStock({ pId: g, remain: 40 });
    await deadStock.createBranchStock({ pId: h, remain: 10 });
    await deadStock.createBranchStock({ pId: i, remain: 25 });
    await deadStock.createBranchStock({ pId: j, remain: 5 });
    await deadStock.createBranchStock({ pId: k, remain: 0 });
    await deadStock.createBranchStock({
      pId: l,
      remain: 30,
      expiredDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await deadStock.createBranchStock({
      pId: m,
      remain: 30,
      status: "pending",
    });
    await deadStock.createBranchStock({ pId: n, remain: 30 });
    await deadStock.createBranchStock({
      pId: o,
      remain: 30,
      branchId: deadStock.otherBranchId,
    });
    await deadStock.createBranchStock({ pId: p, remain: 15 });
    await deadStock.createBranchStock({ pId: p, remain: 10 });

    await deadStock.recordSale({
      createdAt: DS_IN_WINDOW,
      lines: [{ pId: h, quantity: 1, unitPrice: 10 }],
    });
    await deadStock.recordSale({
      createdAt: DS_BEFORE_WINDOW,
      lines: [{ pId: i, quantity: 1, unitPrice: 10 }],
    });
    await deadStock.recordSale({
      createdAt: DS_IN_WINDOW,
      branchId: deadStock.otherBranchId,
      lines: [{ pId: j, quantity: 1, unitPrice: 10 }],
    });
    await deadStock.recordSale({
      createdAt: DS_IN_WINDOW,
      status: "pending",
      lines: [{ pId: p, quantity: 1, unitPrice: 10 }],
    });
  });

  afterAll(async () => {
    await deadStock.cleanup();
  });

  test("lists unsold on-hand products, most units first", async () => {
    const result = await analyticsService.getDeadStock(
      actor,
      deadStockWindow(),
    );

    // i and p tie on 25 units, so pId decides
    expect(pIdsOfDeadStock(result)).toEqual([g, i, p, j]);
    expect(result.totalCount).toBe(4);
  });

  test("leaves out anything sold, out of stock, expired, unreceived, inactive, or elsewhere", async () => {
    const pIds = pIdsOfDeadStock(
      await analyticsService.getDeadStock(actor, deadStockWindow()),
    );

    expect(pIds).not.toContain(h); // sold in the window
    expect(pIds).not.toContain(k); // remain 0
    expect(pIds).not.toContain(l); // expired
    expect(pIds).not.toContain(m); // branch order still pending
    expect(pIds).not.toContain(n); // inactive
    expect(pIds).not.toContain(o); // stocked at the other branch
  });

  test("sums on-hand stock across lots and reports when it last sold", async () => {
    const result = await analyticsService.getDeadStock(
      actor,
      deadStockWindow(),
    );
    const byPId = new Map(result.result.map((row) => [row.pId, row]));

    expect(byPId.get(g)).toMatchObject({
      onHandQuantity: 40,
      lastSoldAt: null,
    });
    expect(byPId.get(i)).toMatchObject({
      onHandQuantity: 25,
      lastSoldAt: DS_BEFORE_WINDOW.toISOString(),
    });
    // a sale at another branch isn't a sale here
    expect(byPId.get(j)).toMatchObject({ onHandQuantity: 5, lastSoldAt: null });
    // two lots, and a pending sale doesn't count
    expect(byPId.get(p)).toMatchObject({
      onHandQuantity: 25,
      lastSoldAt: null,
    });
    expect(byPId.get(g)?.categories).toEqual([
      expect.objectContaining({ categoryId: deadStock.categoryId }),
    ]);
  });

  test("a sale before the window doesn't keep a product off the list, one inside it does", async () => {
    const widened = await analyticsService.getDeadStock(
      actor,
      deadStockWindow({ from: DS_BEFORE_WINDOW.toISOString() }),
    );

    expect(pIdsOfDeadStock(widened)).toEqual([g, p, j]);
  });

  test("limit/offset page through it, totalCount still covers every page", async () => {
    const result = await analyticsService.getDeadStock(
      actor,
      deadStockWindow({ limit: 2, offset: 1 }),
    );

    expect(pIdsOfDeadStock(result)).toEqual([i, p]);
    expect(result.totalCount).toBe(4);
  });

  test("categoryId narrows to that category", async () => {
    const inCategory = await analyticsService.getDeadStock(
      actor,
      deadStockWindow({ categoryId: deadStock.categoryId }),
    );
    const otherCategory = await analyticsService.getDeadStock(
      actor,
      deadStockWindow({ categoryId: 2_000_000_000 }),
    );

    expect(pIdsOfDeadStock(inCategory)).toEqual([g, i, p, j]);
    expect(otherCategory).toMatchObject({ totalCount: 0, result: [] });
  });

  test("echoes the timeframe it used", async () => {
    const result = await analyticsService.getDeadStock(
      actor,
      deadStockWindow(),
    );

    expect(result.from).toBe(DS_FROM.toISOString());
    expect(result.to).toBe(DS_TO.toISOString());
  });

  test("rejects from >= to with BAD_REQUEST", async () => {
    const error = await expectAppError(
      analyticsService.getDeadStock(actor, {
        from: DS_TO.toISOString(),
        to: DS_FROM.toISOString(),
      }),
    );

    expect(error.code).toBe("BAD_REQUEST");
  });

  test("rejects an actor without a branch with FORBIDDEN", async () => {
    const error = await expectAppError(
      analyticsService.getDeadStock(branchActor(null), deadStockWindow()),
    );

    expect(error.code).toBe("FORBIDDEN");
  });
});
