import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type {
  DeadStockResult,
  SellerRankingResult,
} from "@/models/analytics.model";
import { errorHandler } from "@/plugins/error-handler";
import { analyticsRoute, authRoute } from "@/routes";
import {
  type AnalyticsFixture,
  type TestUser,
  setupAnalyticsFixture,
} from "../helpers/analytics";

// Same composition as the real app (src/index.ts), minus the /api/v1
// grouping — authRoute for real sign-in, errorHandler + analyticsRoute (which
// pulls in authPlugin itself) for the API under test.
const app = new Elysia().use(authRoute).use(errorHandler).use(analyticsRoute);

interface SuccessBody<T> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; context?: Record<string, unknown> };
}

// The ranking logic itself is covered in test/services/analytics.service.test.ts;
// this file is about what the HTTP layer adds — auth, query validation, and
// the envelope — so it only seeds one sale to see come back.
const FROM = "2001-01-01T00:00:00.000Z";
const TO = "2001-02-01T00:00:00.000Z";

const ROUTES = ["/analytics/hq/best-sellers", "/analytics/hq/worst-sellers"];

let fixture: AnalyticsFixture;
let hqCookie: string;
let branchCookie: string;
let soldPId: number;

async function signIn({ email, password }: TestUser) {
  const response = await app.handle(
    new Request("http://localhost/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );

  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function get(path: string, query: Record<string, string>, cookie?: string) {
  const search = new URLSearchParams(query).toString();
  return app.handle(
    new Request(`http://localhost${path}${search ? `?${search}` : ""}`, {
      headers: cookie ? { Cookie: cookie } : {},
    }),
  );
}

beforeAll(async () => {
  fixture = await setupAnalyticsFixture("routeanalytics");
  hqCookie = await signIn(fixture.hqUser);
  branchCookie = await signIn(fixture.branchUser);

  soldPId = await fixture.createProduct();
  await fixture.recordSale({
    createdAt: new Date("2001-01-15T12:00:00.000Z"),
    lines: [{ pId: soldPId, quantity: 3, unitPrice: 25 }],
  });
});

afterAll(async () => {
  await fixture.cleanup();
});

describe.each(ROUTES)("GET %s", (path) => {
  test("returns 401 without a session", async () => {
    const response = await get(path, {});
    expect(response.status).toBe(401);
  });

  test("returns 403 for a branch user", async () => {
    const response = await get(path, {}, branchCookie);
    expect(response.status).toBe(403);
  });

  test("returns the ranking in the success envelope for hq", async () => {
    const response = await get(
      path,
      {
        from: FROM,
        to: TO,
        categoryId: String(fixture.categoryId),
      },
      hqCookie,
    );
    const body = (await response.json()) as SuccessBody<SellerRankingResult>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ from: FROM, to: TO, sortBy: "revenue" });
    expect(body.data.result).toEqual([
      {
        rank: 1,
        pId: soldPId,
        productName: expect.any(String) as string,
        barcode: expect.any(String) as string,
        categories: [
          {
            categoryId: fixture.categoryId,
            categoryName: expect.any(String) as string,
          },
        ],
        totalRevenue: 75,
        totalQuantity: 3,
        orderCount: 1,
      },
    ]);
  });

  test("accepts sortBy=quantity", async () => {
    const response = await get(
      path,
      { from: FROM, to: TO, sortBy: "quantity" },
      hqCookie,
    );
    const body = (await response.json()) as SuccessBody<SellerRankingResult>;

    expect(response.status).toBe(200);
    expect(body.data.sortBy).toBe("quantity");
  });

  test.each([
    ["a malformed from", { from: "not-a-date" }],
    ["limit 0", { limit: "0" }],
    ["limit above 50", { limit: "51" }],
    ["a fractional limit", { limit: "1.5" }],
    ["an unknown sortBy", { sortBy: "profit" }],
    ["a non-numeric branchId", { branchId: "abc" }],
  ])("returns 400 VALIDATION for %s", async (_, query) => {
    const response = await get(path, query, hqCookie);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });

  test("returns 400 BAD_REQUEST when from is not before to", async () => {
    const response = await get(path, { from: TO, to: FROM }, hqCookie);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("returns 404 NOT_FOUND for an unknown branchId", async () => {
    const response = await get(
      path,
      { from: FROM, to: TO, branchId: "2000000000" },
      hqCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// The branch routes get their own fixture: the stock they seed would
// otherwise turn up as zero-sale products in the HQ worst-seller check above.
describe("branch analytics routes", () => {
  const BRANCH_ROUTES = [
    "/analytics/branch/best-sellers",
    "/analytics/branch/dead-stock",
  ];

  let branchFixture: AnalyticsFixture;
  let ownBranchCookie: string;
  let ownHqCookie: string;
  let soldHere: number;
  let soldElsewhere: number;
  let unsold: number;

  beforeAll(async () => {
    branchFixture = await setupAnalyticsFixture("routebranchanalytics");
    ownBranchCookie = await signIn(branchFixture.branchUser);
    ownHqCookie = await signIn(branchFixture.hqUser);

    soldHere = await branchFixture.createProduct();
    soldElsewhere = await branchFixture.createProduct();
    unsold = await branchFixture.createProduct();

    await branchFixture.createBranchStock({ pId: soldHere, remain: 7 });
    await branchFixture.createBranchStock({ pId: unsold, remain: 12 });

    await branchFixture.recordSale({
      createdAt: new Date("2001-01-15T12:00:00.000Z"),
      lines: [{ pId: soldHere, quantity: 2, unitPrice: 30 }],
    });
    await branchFixture.recordSale({
      createdAt: new Date("2001-01-15T12:00:00.000Z"),
      branchId: branchFixture.otherBranchId,
      lines: [{ pId: soldElsewhere, quantity: 9, unitPrice: 30 }],
    });
  });

  afterAll(async () => {
    await branchFixture.cleanup();
  });

  describe.each(BRANCH_ROUTES)("GET %s", (path) => {
    test("returns 401 without a session", async () => {
      const response = await get(path, {});
      expect(response.status).toBe(401);
    });

    test("returns 403 for an hq user", async () => {
      const response = await get(path, {}, ownHqCookie);
      expect(response.status).toBe(403);
    });

    test.each([
      ["a malformed from", { from: "not-a-date" }],
      ["limit 0", { limit: "0" }],
      ["a fractional limit", { limit: "1.5" }],
      ["a non-numeric categoryId", { categoryId: "abc" }],
    ])("returns 400 VALIDATION for %s", async (_, query) => {
      const response = await get(path, query, ownBranchCookie);
      const body = (await response.json()) as ErrorBody;

      expect(response.status).toBe(400);
      expect(body.error.code).toBe("VALIDATION");
    });

    test("returns 400 BAD_REQUEST when from is not before to", async () => {
      const response = await get(path, { from: TO, to: FROM }, ownBranchCookie);
      const body = (await response.json()) as ErrorBody;

      expect(response.status).toBe(400);
      expect(body.error.code).toBe("BAD_REQUEST");
    });
  });

  test("best-sellers ranks only the caller's own branch", async () => {
    const response = await get(
      "/analytics/branch/best-sellers",
      { from: FROM, to: TO },
      ownBranchCookie,
    );
    const body = (await response.json()) as SuccessBody<SellerRankingResult>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    // soldElsewhere sold more, but at the other branch
    expect(body.data.result.map((row) => row.pId)).toEqual([soldHere]);
    expect(body.data.result[0]).toMatchObject({
      rank: 1,
      totalRevenue: 60,
      totalQuantity: 2,
      orderCount: 1,
    });
  });

  test("best-sellers rejects sortBy=profit", async () => {
    const response = await get(
      "/analytics/branch/best-sellers",
      { sortBy: "profit" },
      ownBranchCookie,
    );

    expect(response.status).toBe(400);
  });

  test("dead-stock lists on-hand products that didn't sell, in the envelope", async () => {
    const response = await get(
      "/analytics/branch/dead-stock",
      { from: FROM, to: TO },
      ownBranchCookie,
    );
    const body = (await response.json()) as SuccessBody<DeadStockResult>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      from: FROM,
      to: TO,
      totalCount: 1,
      result: [
        {
          pId: unsold,
          productName: expect.any(String) as string,
          barcode: expect.any(String) as string,
          categories: [
            {
              categoryId: branchFixture.categoryId,
              categoryName: expect.any(String) as string,
            },
          ],
          onHandQuantity: 12,
          lastSoldAt: null,
        },
      ],
    });
  });

  test.each([
    ["limit above 100", { limit: "101" }],
    ["a negative offset", { offset: "-1" }],
  ])("dead-stock returns 400 VALIDATION for %s", async (_, query) => {
    const response = await get(
      "/analytics/branch/dead-stock",
      query,
      ownBranchCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });
});
