import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { db } from "@/db/client";
import { headOrderDetail } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { NotificationAlertEntry } from "@/models/notification.model";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, notificationsRoute, ordersBranchRoute } from "@/routes";
import {
  daysFromNow,
  type OrdersBranchFixture,
  setupOrdersBranchFixture,
  type TestUser,
} from "../helpers/orders-branch";

// Same composition as the real app (src/index.ts), minus the /api/v1 group:
// authRoute for real sign-in, errorHandler for the AppError -> envelope
// conversion, ordersBranchRoute because US-2.9/US-3.5's "stock changed"
// preconditions go through the real POST /orders/branch handler (the one
// code path that actually moves HQ and branch stock today), notificationsRoute
// for the alerts themselves.
const app = new Elysia()
  .use(authRoute)
  .use(errorHandler)
  .use(ordersBranchRoute)
  .use(notificationsRoute);

interface SuccessBody<T> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; context?: Record<string, unknown> };
}

async function signIn({ email, password }: TestUser): Promise<string> {
  const response = await app.handle(
    new Request("http://localhost/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error(`sign-in failed for ${email}`);

  return cookie;
}

function get(path: string, cookie: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }),
  );
}

function post(path: string, cookie: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { Cookie: cookie },
    }),
  );
}

function placeBranchOrder(
  cookie: string,
  items: { pId: number; amount: number }[],
): Promise<Response> {
  return app.handle(
    new Request("http://localhost/orders/branch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ items }),
    }),
  );
}

function patch(path: string, cookie: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "PATCH",
      headers: { Cookie: cookie },
    }),
  );
}

/** HQ approves a pending branch order — the point that draws down HQ stock
 * and fills in the branch order's line items. Returns the order's lotId. */
async function approveOrder(
  orderResponse: Response,
  hqCookie: string,
): Promise<number> {
  const body = (await orderResponse.json()) as SuccessBody<{ lotId: number }>;
  const lotId = body.data.lotId;

  const approved = await patch(`/orders/branch/${lotId}/approve`, hqCookie);
  expect(approved.status).toBe(200);

  return lotId;
}

/** HQ approves, then the branch confirms receipt — the flow that actually
 * settles the stock move and is what raises/resolves the HQ alerts under
 * test. */
async function approveAndReceive(
  orderResponse: Response,
  hqCookie: string,
  branchCookie: string,
): Promise<void> {
  const lotId = await approveOrder(orderResponse, hqCookie);

  const received = await patch(`/orders/branch/${lotId}/receive`, branchCookie);
  expect(received.status).toBe(200);
}

let fixture: OrdersBranchFixture;
let otherFixture: OrdersBranchFixture;
let hqCookie: string;
let branchCookie: string;
let otherBranchCookie: string;

beforeAll(async () => {
  fixture = await setupOrdersBranchFixture("notifroute");
  otherFixture = await setupOrdersBranchFixture("notifroute-other");

  hqCookie = await signIn(fixture.hqUser);
  branchCookie = await signIn(fixture.branchUser);
  otherBranchCookie = await signIn(otherFixture.branchUser);
});

afterAll(async () => {
  await fixture.cleanup();
  await otherFixture.cleanup();
});

// US-2.9: As a HQ Admin, given a product has a configured minimum stock
// level or expiration date, I want to receive notifications when products
// are low in stock or approaching their expiration date.
describe("US-2.9: HQ inventory alerts", () => {
  test("a min_stock alert appears once a branch order draws HQ stock below the product's configured minStockHq", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    // Given: 10 in stock, threshold 5 — nothing to alert on yet.
    const before = await get("/notifications/hq/min-stock", hqCookie);
    const beforeBody = (await before.json()) as SuccessBody<{
      result: NotificationAlertEntry[];
    }>;
    expect(beforeBody.data.result.some((a) => a.pId === pId)).toBe(false);

    // When: the stock falls below the threshold (draw 8, 2 left < 5) — HQ
    // approves and the branch receives, the flow that draws down HQ stock
    // and raises the alert.
    const orderResponse = await placeBranchOrder(branchCookie, [
      { pId, amount: 8 },
    ]);
    expect(orderResponse.status).toBe(200);
    await approveAndReceive(orderResponse, hqCookie, branchCookie);

    // Then: the system sends a notification, identifying the affected
    // product and its current stock.
    const after = await get("/notifications/hq/min-stock", hqCookie);
    const afterBody = (await after.json()) as SuccessBody<{
      result: NotificationAlertEntry[];
    }>;
    const alert = afterBody.data.result.find((a) => a.pId === pId);
    expect(alert).toBeDefined();
    expect(alert?.quantity).toBe(2);
    expect(alert?.productName).toBeTruthy();
    expect(alert?.barcode).toBeTruthy();
  });

  test("the min_stock alert clears once stock is back at/above the threshold", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    const lot = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    const orderResponse = await placeBranchOrder(branchCookie, [
      { pId, amount: 8 },
    ]);
    await approveAndReceive(orderResponse, hqCookie, branchCookie); // remain -> 2, opens the alert

    const shortage = await get("/notifications/hq/min-stock", hqCookie);
    const shortageBody = (await shortage.json()) as SuccessBody<{
      result: NotificationAlertEntry[];
    }>;
    expect(shortageBody.data.result.some((a) => a.pId === pId)).toBe(true);

    // Stock gets replenished (out of scope: ordersHqService.create() isn't
    // built yet, so this stands in for "HQ receives more stock").
    await db
      .update(headOrderDetail)
      .set({ remain: 20 })
      .where(eq(headOrderDetail.lotId, lot.lotId));

    // When the system re-detects inventory status...
    const scan = await post("/notifications/scan", hqCookie);
    expect(scan.status).toBe(200);

    const resolved = await get("/notifications/hq/min-stock", hqCookie);
    const resolvedBody = (await resolved.json()) as SuccessBody<{
      result: NotificationAlertEntry[];
    }>;
    expect(resolvedBody.data.result.some((a) => a.pId === pId)).toBe(false);
  });

  test("an expire alert appears for an HQ lot inside the warning window, and not for one further out", async () => {
    const soonPId = await fixture.createProduct();
    const laterPId = await fixture.createProduct();
    await fixture.createHqLot({
      pId: soonPId,
      remain: 7,
      expiredDate: daysFromNow(3),
    });
    await fixture.createHqLot({
      pId: laterPId,
      remain: 7,
      expiredDate: daysFromNow(30),
    });

    // When the system detects the expiration status...
    const scan = await post("/notifications/scan", hqCookie);
    expect(scan.status).toBe(200);

    // Then it identifies the affected product/stock approaching expiry...
    const response = await get("/notifications/hq/expire", hqCookie);
    const body = (await response.json()) as SuccessBody<{
      result: NotificationAlertEntry[];
    }>;
    const soonAlert = body.data.result.find((a) => a.pId === soonPId);
    expect(soonAlert).toBeDefined();
    expect(soonAlert?.quantity).toBe(7);
    expect(soonAlert?.productName).toBeTruthy();

    // ...and doesn't flag one that isn't approaching expiry yet.
    expect(body.data.result.some((a) => a.pId === laterPId)).toBe(false);
  });

  test("HQ alert endpoints are not accessible to a branch user", async () => {
    const minStock = await get("/notifications/hq/min-stock", branchCookie);
    const expire = await get("/notifications/hq/expire", branchCookie);
    const scan = await post("/notifications/scan", branchCookie);

    expect(minStock.status).toBe(403);
    expect(expire.status).toBe(403);
    expect(scan.status).toBe(403);
  });
});

// US-3.5: As a Branch User, given the stock has changed and the amount is
// lower than the minimum stock limit, or products are expiring within 7
// days, I want to receive automated alerts so I can proactively reorder or
// manage clearance sales.
describe("US-3.5: branch inventory alerts", () => {
  test("a min_stock alert appears once the branch's incoming stock is still under the product's configured minStockBranch", async () => {
    const pId = await fixture.createProduct({ minStockBranch: 10 });
    await fixture.createHqLot({
      pId,
      remain: 50,
      expiredDate: daysFromNow(30),
    });

    // Given: the stock has changed (branch requests 4, HQ approves) and is
    // lower than the minimum stock limit (10).
    const orderResponse = await placeBranchOrder(branchCookie, [
      { pId, amount: 4 },
    ]);
    expect(orderResponse.status).toBe(200);
    await approveOrder(orderResponse, hqCookie);

    // Branch min_stock alerts only open on a scan — there's no consuming
    // order flow yet to hang detection on synchronously (see
    // notification.service.ts's top comment).
    const scan = await post("/notifications/scan", hqCookie);
    expect(scan.status).toBe(200);

    // When: the notification view is selected...
    const response = await get(
      `/notifications/branches/${fixture.branchId}/min-stock`,
      branchCookie,
    );

    // Then: the system displays the low-stock product.
    const body = (await response.json()) as SuccessBody<{
      result: NotificationAlertEntry[];
    }>;
    const alert = body.data.result.find((a) => a.pId === pId);
    expect(alert).toBeDefined();
    expect(alert?.quantity).toBe(4);
  });

  test("an expire alert appears for a branch lot inside the warning window once the branch user checks the expiry alerts", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({
      pId,
      remain: 20,
      expiredDate: daysFromNow(3),
    });

    const orderResponse = await placeBranchOrder(branchCookie, [
      { pId, amount: 6 },
    ]);
    expect(orderResponse.status).toBe(200);
    await approveOrder(orderResponse, hqCookie);

    await post("/notifications/scan", hqCookie); // the system detects the expiration status

    // When the Branch User checks the expiry alerts...
    const response = await get(
      `/notifications/branches/${fixture.branchId}/expire`,
      branchCookie,
    );

    // Then the system displays the near-expiry item.
    const body = (await response.json()) as SuccessBody<{
      result: NotificationAlertEntry[];
    }>;
    const alert = body.data.result.find((a) => a.pId === pId);
    expect(alert).toBeDefined();
    expect(alert?.quantity).toBe(6);
  });

  test("a branch user cannot view another branch's alerts, but hq can view any branch's", async () => {
    const forbidden = await get(
      `/notifications/branches/${fixture.branchId}/min-stock`,
      otherBranchCookie,
    );
    const forbiddenBody = (await forbidden.json()) as ErrorBody;
    expect(forbidden.status).toBe(403);
    expect(forbiddenBody.error.code).toBe("FORBIDDEN");

    const asHq = await get(
      `/notifications/branches/${fixture.branchId}/min-stock`,
      hqCookie,
    );
    expect(asHq.status).toBe(200);
  });
});
