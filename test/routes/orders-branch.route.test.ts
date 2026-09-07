import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { max } from "drizzle-orm";
import { db } from "@/db/client";
import { product } from "@/db/schema";
import type { OrdersBranchCreateResponse } from "@/models/orders-branch.model";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, ordersBranchRoute } from "@/routes";
import {
  daysFromNow,
  type OrdersBranchFixture,
  setupOrdersBranchFixture,
  type TestUser,
} from "../helpers/orders-branch";

// same composition as the real app (src/index.ts), minus the /api/v1 group:
// authRoute is needed because the sign-in below goes through the real
// /api/v1/auth/sign-in/email handler, and errorHandler because these tests
// assert on the AppError -> envelope conversion it owns.
const app = new Elysia()
  .use(authRoute)
  .use(errorHandler)
  .use(ordersBranchRoute);

interface SuccessBody<T> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; context?: Record<string, unknown> };
}

let fixture: OrdersBranchFixture;
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
    new Request("http://localhost/orders/branch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  fixture = await setupOrdersBranchFixture("routebranchorder");
  branchCookie = await signIn(fixture.branchUser);
  hqCookie = await signIn(fixture.hqUser);
});

afterAll(async () => {
  await fixture.cleanup();
});

describe("POST /orders/branch", () => {
  test("returns the created order and its line items in a success envelope", async () => {
    const pId = await fixture.createProduct(15);
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
      basePrice: 40,
    });

    const response = await postOrder(
      { items: [{ pId, amount: 4 }] },
      branchCookie,
    );
    const body = (await response.json()) as SuccessBody<
      // expiredDate/createdAt arrive as ISO strings once serialized
      OrdersBranchCreateResponse
    >;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      orderType: "branch",
      status: "pending",
      userId: fixture.branchUser.id,
    });
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      pId,
      branchId: fixture.branchId,
      amount: 4,
      remain: 4,
      costPrice: 15,
      basePrice: 40,
    });
  });

  test("returns 404 with an AppError envelope when a pId does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(product.pId) })
      .from(product);

    const response = await postOrder(
      { items: [{ pId: (highest ?? 0) + 1000, amount: 1 }] },
      branchCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 409 with an AppError envelope when HQ stock is short", async () => {
    const pId = await fixture.createProduct();
    // only 2 left in the lot, so 3 is already short
    await fixture.createHqLot({
      pId,
      remain: 2,
      expiredDate: daysFromNow(30),
    });

    const response = await postOrder(
      { items: [{ pId, amount: 3 }] },
      branchCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INSUFFICIENT_STOCK");
  });

  test("returns 400 with a normalized envelope for a body that fails schema validation", async () => {
    const response = await postOrder({ items: [] }, branchCookie);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION");
  });

  test("returns 401 without a session", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    const response = await postOrder({ items: [{ pId, amount: 1 }] });

    expect(response.status).toBe(401);
  });

  test("returns 403 for a signed-in user that isn't a branch", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    const response = await postOrder({ items: [{ pId, amount: 1 }] }, hqCookie);

    expect(response.status).toBe(403);
  });
});
