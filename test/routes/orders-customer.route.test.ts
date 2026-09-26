import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { max } from "drizzle-orm";
import { db } from "@/db/client";
import { order, product } from "@/db/schema";
import type {
  OrdersCustomerCreateResponse,
  OrdersCustomerGetByLotIdResponse,
  OrdersCustomerGetResponse,
} from "@/models/orders-customer.model";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, ordersCustomerRoute } from "@/routes";
import {
  daysFromNow,
  type OrdersCustomerFixture,
  setupOrdersCustomerFixture,
  type TestUser,
} from "../helpers/orders-customer";

// same composition as the real app (src/index.ts), minus the /api/v1 group:
// authRoute is needed because the sign-in below goes through the real
// /api/v1/auth/sign-in/email handler, and errorHandler because these tests
// assert on the AppError -> envelope conversion it owns.
const app = new Elysia()
  .use(authRoute)
  .use(errorHandler)
  .use(ordersCustomerRoute);

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
let otherBranchCashierCookie: string;
let branchCookie: string;
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

function postOrder(body: unknown, cookie?: string): Promise<Response> {
  return app.handle(
    new Request("http://localhost/orders/customer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function patchConfirmPayment(
  lotId: number,
  cookie?: string,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/orders/customer/${lotId}/confirm-payment`, {
      method: "PATCH",
      headers: { ...(cookie ? { Cookie: cookie } : {}) },
    }),
  );
}

function patchCancel(lotId: number, cookie?: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/orders/customer/${lotId}/cancel`, {
      method: "PATCH",
      headers: { ...(cookie ? { Cookie: cookie } : {}) },
    }),
  );
}

function getOrders(query: string, cookie?: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/orders/customer${query}`, {
      headers: { ...(cookie ? { Cookie: cookie } : {}) },
    }),
  );
}

function getOrderById(lotId: number, cookie?: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/orders/customer/${lotId}`, {
      headers: { ...(cookie ? { Cookie: cookie } : {}) },
    }),
  );
}

async function ringUp(
  pId: number,
  quantity: number,
  paymentMethod: "cash" | "qr" = "cash",
): Promise<number> {
  const response = await postOrder(
    { paymentMethod, items: [{ pId, quantity }] },
    cashierCookie,
  );
  const body =
    (await response.json()) as SuccessBody<OrdersCustomerCreateResponse>;

  return body.data.lotId;
}

beforeAll(async () => {
  fixture = await setupOrdersCustomerFixture("routecustomerorder");
  cashierCookie = await signIn(fixture.cashierUser);
  otherBranchCashierCookie = await signIn(fixture.otherBranchCashierUser);
  branchCookie = await signIn(fixture.branchUser);
  hqCookie = await signIn(fixture.hqUser);
});

afterAll(async () => {
  await fixture.cleanup();
});

describe("POST /orders/customer", () => {
  test("cash: returns the completed order in a success envelope", async () => {
    const pId = await fixture.createProduct(10);
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    const response = await postOrder(
      { paymentMethod: "cash", items: [{ pId, quantity: 3 }] },
      cashierCookie,
    );
    const body =
      (await response.json()) as SuccessBody<OrdersCustomerCreateResponse>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      orderType: "customer",
      status: "completed",
      userId: fixture.cashierUser.id,
    });
    expect(body.data.items[0]).toMatchObject({ pId, quantity: 3 });
    expect(body.data.paymentUrl).toBeUndefined();
  });

  test("qr: returns a pending order with a paymentUrl", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    const response = await postOrder(
      { paymentMethod: "qr", items: [{ pId, quantity: 2 }] },
      cashierCookie,
    );
    const body =
      (await response.json()) as SuccessBody<OrdersCustomerCreateResponse>;

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("pending");
    expect(body.data.paymentUrl).toBe(
      `/orders/customer/${body.data.lotId}/confirm-payment`,
    );
  });

  test("returns 404 with an AppError envelope when a pId does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(product.pId) })
      .from(product);

    const response = await postOrder(
      {
        paymentMethod: "cash",
        items: [{ pId: (highest ?? 0) + 1000, quantity: 1 }],
      },
      cashierCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 409 with an AppError envelope when stock is short", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 1,
      expiredDate: daysFromNow(30),
    });

    const response = await postOrder(
      { paymentMethod: "cash", items: [{ pId, quantity: 5 }] },
      cashierCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("INSUFFICIENT_STOCK");
  });

  test("returns 400 with a normalized envelope for a body that fails schema validation", async () => {
    const response = await postOrder(
      { paymentMethod: "cash", items: [] },
      cashierCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });

  test("returns 401 without a session", async () => {
    const pId = await fixture.createProduct();

    const response = await postOrder({
      paymentMethod: "cash",
      items: [{ pId, quantity: 1 }],
    });

    expect(response.status).toBe(401);
  });

  test("returns 403 for a signed-in user that isn't a cashier", async () => {
    const pId = await fixture.createProduct();

    const response = await postOrder(
      { paymentMethod: "cash", items: [{ pId, quantity: 1 }] },
      hqCookie,
    );

    expect(response.status).toBe(403);
  });
});

describe("PATCH /orders/customer/:lotId/confirm-payment", () => {
  test("succeeds with no Cookie header at all — the one public route in this suite", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 2, "qr");

    const response = await patchConfirmPayment(lotId);
    const body =
      (await response.json()) as SuccessBody<OrdersCustomerGetByLotIdResponse>;

    expect(response.status).not.toBe(401);
    expect(response.status).toBe(200);
    expect(body.data.status).toBe("completed");
  });

  test("returns 404 with an AppError envelope for an unknown lotId", async () => {
    const [{ highest }] = await db
      .select({ highest: max(order.lotId) })
      .from(order);

    const response = await patchConfirmPayment((highest ?? 0) + 1000);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 400 on double-confirm", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 2, "qr");
    await patchConfirmPayment(lotId);

    const response = await patchConfirmPayment(lotId);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

describe("PATCH /orders/customer/:lotId/cancel", () => {
  test("returns the rejected order for the owning cashier", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 2, "qr");

    const response = await patchCancel(lotId, cashierCookie);
    const body =
      (await response.json()) as SuccessBody<OrdersCustomerGetByLotIdResponse>;

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("rejected");
  });

  test("returns 403 for a cashier at a different branch", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 2, "qr");

    const response = await patchCancel(lotId, otherBranchCashierCookie);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("returns 400 cancelling an already-completed order", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 2, "cash");

    const response = await patchCancel(lotId, cashierCookie);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("returns 401 without a session", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 2, "qr");

    const response = await patchCancel(lotId);

    expect(response.status).toBe(401);
  });

  test("returns 403 for a signed-in user that isn't a cashier", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 2, "qr");

    const response = await patchCancel(lotId, branchCookie);

    expect(response.status).toBe(403);
  });

  test("cancel-then-confirm fails because the order is no longer pending", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 2, "qr");
    await patchCancel(lotId, cashierCookie);

    const response = await patchConfirmPayment(lotId);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

describe("GET /orders/customer and /:lotId", () => {
  test("returns 401 without a session", async () => {
    const response = await getOrders("");
    expect(response.status).toBe(401);
  });

  test("scopes a cashier's list to their own branch", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 1, "cash");

    const response = await getOrders("", cashierCookie);
    const body =
      (await response.json()) as SuccessBody<OrdersCustomerGetResponse>;

    expect(response.status).toBe(200);
    expect(body.data.orders.some((o) => o.lotId === lotId)).toBe(true);
  });

  test("returns 403 when a different branch reads the order by id", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 1, "cash");

    const response = await getOrderById(lotId, otherBranchCashierCookie);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("returns 403 for hq — no hq-wide view of customer orders", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const lotId = await ringUp(pId, 1, "cash");

    const byIdResponse = await getOrderById(lotId, hqCookie);
    expect(byIdResponse.status).toBe(403);

    const listResponse = await getOrders("", hqCookie);
    expect(listResponse.status).toBe(403);
  });
});
