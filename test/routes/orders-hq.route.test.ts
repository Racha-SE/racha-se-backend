import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { max } from "drizzle-orm";
import { Elysia, type Static } from "elysia";
import { db } from "@/db/client";
import { product, supplier } from "@/db/schema";
import { OrdersHqModel } from "@/models/orders-hq.model";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, ordersHqRoute } from "@/routes";
import {
  daysFromNow,
  type OrdersHqFixture,
  setupOrdersHqFixture,
  type TestUser,
} from "../helpers/orders-hq";

// same composition as the real app (src/index.ts), minus the /api/v1 group:
// authRoute is needed because the sign-in below goes through the real
// /api/v1/auth/sign-in/email handler, and errorHandler because these tests
// assert on the AppError -> envelope conversion it owns.
const app = new Elysia().use(authRoute).use(errorHandler).use(ordersHqRoute);

// createBodyResponse is the shape the route documents; over the wire the
// timestamps in it arrive as ISO strings.
type OrdersHqCreateResponse = Static<typeof OrdersHqModel.createBodyResponse>;

interface SuccessBody<T> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; context?: Record<string, unknown> };
}

let fixture: OrdersHqFixture;
let hqCookie: string;
let branchCookie: string;

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
    new Request("http://localhost/orders/hq", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

/** A body with one line item, filled in except for what the caller overrides. */
function orderBody(item: {
  pId: number;
  supplierId?: number;
  amount?: number;
  basePrice?: number;
}) {
  return {
    items: [
      {
        supplierId: fixture.supplierId,
        amount: 1,
        expiredDate: daysFromNow(30).toISOString(),
        basePrice: 0,
        ...item,
      },
    ],
  };
}

beforeAll(async () => {
  fixture = await setupOrdersHqFixture("routehqorder");
  hqCookie = await signIn(fixture.hqUser);
  branchCookie = await signIn(fixture.branchUser);
});

afterAll(async () => {
  await fixture.cleanup();
});

describe("POST /orders/hq", () => {
  test("returns the created order and its line items in a success envelope", async () => {
    const pId = await fixture.createProduct();
    const expiredDate = daysFromNow(45);

    const response = await postOrder(
      {
        items: [
          {
            pId,
            supplierId: fixture.supplierId,
            amount: 6,
            expiredDate: expiredDate.toISOString(),
            basePrice: 25,
          },
        ],
      },
      hqCookie,
    );
    const body = (await response.json()) as SuccessBody<OrdersHqCreateResponse>;

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      orderType: "hq",
      status: "approved",
      userId: fixture.hqUser.id,
      approvedBy: fixture.hqUser.id,
    });
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      pId,
      supplierId: fixture.supplierId,
      amount: 6,
      remain: 6,
      basePrice: 25,
    });
    expect(new Date(body.data.items[0].expiredDate)).toEqual(expiredDate);
  });

  test("resolves the product's open HQ min_stock alert", async () => {
    const pId = await fixture.createProduct({ minStockHq: 10 });
    await fixture.createHqStock({ pId, remain: 4 });
    const notificationId = await fixture.createMinStockNotification({
      pId,
      quantity: 4,
    });

    const response = await postOrder(orderBody({ pId, amount: 6 }), hqCookie);

    expect(response.status).toBe(201);

    const resolved = await fixture.getNotification(notificationId);

    expect(resolved.isResolved).toBe(true);
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
  });

  test("returns 404 with an AppError envelope when a pId does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(product.pId) })
      .from(product);
    const missingPId = (highest ?? 0) + 1000;

    const response = await postOrder(orderBody({ pId: missingPId }), hqCookie);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 404 with an AppError envelope when a supplierId does not exist", async () => {
    const pId = await fixture.createProduct();
    const [{ highest }] = await db
      .select({ highest: max(supplier.supplierId) })
      .from(supplier);
    const missingSupplierId = (highest ?? 0) + 1000;

    const response = await postOrder(
      orderBody({ pId, supplierId: missingSupplierId }),
      hqCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.context).toMatchObject({
      message: "supplier not found",
      supplierId: missingSupplierId,
    });
  });

  test("returns 400 with a normalized envelope for an empty items array", async () => {
    const response = await postOrder({ items: [] }, hqCookie);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION");
  });

  test("returns 400 when a line item is missing required fields", async () => {
    const pId = await fixture.createProduct();

    // no supplierId, expiredDate or basePrice — all required by createBody
    const response = await postOrder({ items: [{ pId, amount: 1 }] }, hqCookie);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });

  test("returns 400 for an amount below the schema minimum", async () => {
    const pId = await fixture.createProduct();

    const response = await postOrder(orderBody({ pId, amount: 0 }), hqCookie);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });

  test("returns 401 without a session", async () => {
    const pId = await fixture.createProduct();

    const response = await postOrder(orderBody({ pId }));

    expect(response.status).toBe(401);
  });

  test("returns 403 for a signed-in user that isn't hq", async () => {
    const pId = await fixture.createProduct();

    const response = await postOrder(orderBody({ pId }), branchCookie);

    expect(response.status).toBe(403);
  });
});
