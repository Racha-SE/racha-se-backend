import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, ordersCustomerRoute, reportsRoute } from "@/routes";
import type { OrdersCustomerCreateResponse } from "@/models/orders-customer.model";
import type { ReportResult } from "@/models/reports.model";
import {
  daysFromNow,
  type OrdersCustomerFixture,
  setupOrdersCustomerFixture,
  type TestUser,
} from "../helpers/orders-customer";

const app = new Elysia()
  .use(authRoute)
  .use(errorHandler)
  .use(ordersCustomerRoute)
  .use(reportsRoute);

interface SuccessBody<T> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; context?: Record<string, unknown> };
}

let fixture: OrdersCustomerFixture;
let cashierCookie: string;
let hqCookie: string;

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

function postOrder(body: unknown, cookie: string): Promise<Response> {
  return app.handle(
    new Request("http://localhost/orders/customer", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    }),
  );
}

function getReport(query: string, cookie?: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/reports${query}`, {
      headers: { ...(cookie ? { Cookie: cookie } : {}) },
    }),
  );
}

beforeAll(async () => {
  fixture = await setupOrdersCustomerFixture("reportsroute");
  cashierCookie = await signIn(fixture.cashierUser);
  hqCookie = await signIn(fixture.hqUser);
});

afterAll(async () => {
  await fixture.cleanup();
});

describe("GET /reports", () => {
  test("format=json returns the same sales/profit numbers as a completed sale", async () => {
    const pId = await fixture.createProduct({ price: 50 });
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
      costPrice: 20,
      price: 50,
    });

    const orderResponse = await postOrder(
      { paymentMethod: "cash", items: [{ pId, quantity: 3 }] },
      cashierCookie,
    );
    const orderBody =
      (await orderResponse.json()) as SuccessBody<OrdersCustomerCreateResponse>;
    expect(orderBody.data.status).toBe("completed");

    const today = new Date().toISOString().slice(0, 10);
    const response = await getReport(
      `?startDate=${today}&endDate=${today}&format=json`,
      hqCookie,
    );
    const body = (await response.json()) as SuccessBody<{
      result: ReportResult[];
    }>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.result)).toBe(true);

    const row = body.data.result.find((entry) => entry.productId === pId);
    expect(row).toMatchObject({
      productId: pId,
      salesQuantity: 3,
      revenue: 150,
      cost: 60,
      profit: 90,
    });
  });

  test("rejects an unsupported format with a validation error", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await getReport(
      `?startDate=${today}&endDate=${today}&format=pdf`,
      hqCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });

  test("end date before start date returns 400 BAD_REQUEST", async () => {
    const response = await getReport(
      "?startDate=2026-01-02&endDate=2026-01-01&format=json",
      hqCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});
