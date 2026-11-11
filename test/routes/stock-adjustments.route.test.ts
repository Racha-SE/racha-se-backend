import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { StockAdjustmentCreateResponse } from "@/models/stock-adjustments.model";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, inventoryRoute } from "@/routes";
import {
  daysFromNow,
  type OrdersCustomerFixture,
  setupOrdersCustomerFixture,
  type TestUser,
} from "../helpers/orders-customer";

// same composition as the real app (src/index.ts), minus the /api/v1 group
const app = new Elysia().use(authRoute).use(errorHandler).use(inventoryRoute);

interface SuccessBody<T> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; context?: Record<string, unknown> };
}

let fixture: OrdersCustomerFixture;
let branchCookie: string;
let cashierCookie: string;

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

function postAdjustment(
  branchId: number,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/inventory/branches/${branchId}/adjustments`, {
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
  fixture = await setupOrdersCustomerFixture("routestockadj");
  branchCookie = await signIn(fixture.branchUser);
  cashierCookie = await signIn(fixture.cashierUser);
});

afterAll(async () => {
  await fixture.cleanup();
});

async function productWithStock(remain = 5): Promise<number> {
  const pId = await fixture.createProduct();
  await fixture.createBranchStock({
    pId,
    remain,
    expiredDate: daysFromNow(30),
  });
  return pId;
}

describe("POST /inventory/branches/:branchId/adjustments", () => {
  test("adjusts stock and returns the record with the new on-hand total", async () => {
    const pId = await productWithStock(5);

    const response = await postAdjustment(
      fixture.branchId,
      { pId, quantityChange: -2, reason: "  damaged  " },
      branchCookie,
    );
    const body =
      (await response.json()) as SuccessBody<StockAdjustmentCreateResponse>;

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      pId,
      quantityChange: -2,
      // stored trimmed
      reason: "damaged",
      onHand: 3,
    });
  });

  test("returns 400 without a reason", async () => {
    const pId = await productWithStock();

    for (const reason of [undefined, "", "   "]) {
      const response = await postAdjustment(
        fixture.branchId,
        { pId, quantityChange: -1, reason },
        branchCookie,
      );
      const body = (await response.json()) as ErrorBody;

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
    }
  });

  test("returns 400 for a zero or non-integer change", async () => {
    const pId = await productWithStock();

    for (const quantityChange of [0, 1.5]) {
      const response = await postAdjustment(
        fixture.branchId,
        { pId, quantityChange, reason: "count error" },
        branchCookie,
      );

      expect(response.status).toBe(400);
    }
  });

  test("returns 409 when removing more than is on hand", async () => {
    const pId = await productWithStock(1);

    const response = await postAdjustment(
      fixture.branchId,
      { pId, quantityChange: -2, reason: "lost" },
      branchCookie,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("INSUFFICIENT_STOCK");
  });

  test("returns 403 for another branch", async () => {
    const pId = await productWithStock();

    const response = await postAdjustment(
      fixture.otherBranchId,
      { pId, quantityChange: -1, reason: "lost" },
      branchCookie,
    );

    expect(response.status).toBe(403);
  });

  test("returns 403 for a cashier", async () => {
    const pId = await productWithStock();

    const response = await postAdjustment(
      fixture.branchId,
      { pId, quantityChange: -1, reason: "lost" },
      cashierCookie,
    );

    expect(response.status).toBe(403);
  });

  test("returns 401 without a session", async () => {
    const pId = await productWithStock();

    const response = await postAdjustment(fixture.branchId, {
      pId,
      quantityChange: -1,
      reason: "lost",
    });

    expect(response.status).toBe(401);
  });
});
