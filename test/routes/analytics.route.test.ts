import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { SellerRankingResult } from "@/models/analytics.model";
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
