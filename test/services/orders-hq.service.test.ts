import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq, max } from "drizzle-orm";
import { db } from "@/db/client";
import { headOrderDetail, order, product, supplier } from "@/db/schema";
import type { OrdersHqCreateBody } from "@/models/orders-hq.model";
import { ordersHqService } from "@/services/orders-hq.service";
import { AppError } from "@/utils";
import {
  daysFromNow,
  type OrdersHqFixture,
  setupOrdersHqFixture,
} from "../helpers/orders-hq";

let fixture: OrdersHqFixture;

beforeAll(async () => {
  fixture = await setupOrdersHqFixture("svchqorder");
});

afterAll(async () => {
  await fixture.cleanup();
});

type LineItem = OrdersHqCreateBody["items"][number];

/** Fills in the parts of a line item no test in here cares about. */
function lineItem(item: Partial<LineItem> & Pick<LineItem, "pId">): LineItem {
  return {
    supplierId: fixture.supplierId,
    amount: 1,
    expiredDate: daysFromNow(30).toISOString(),
    basePrice: 0,
    ...item,
  };
}

function createOrder(items: (Partial<LineItem> & Pick<LineItem, "pId">)[]) {
  return ordersHqService.create(fixture.hqUser.id, {
    items: items.map(lineItem),
  });
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected create to throw an AppError, but it resolved");
}

/** A supplierId past every row in the table, so no supplier can own it. */
async function unusedSupplierId(): Promise<number> {
  const [{ highest }] = await db
    .select({ highest: max(supplier.supplierId) })
    .from(supplier);

  return (highest ?? 0) + 1000;
}

async function countHqOrders(): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(order)
    .where(and(eq(order.userId, fixture.hqUser.id), eq(order.orderType, "hq")));

  return row.total;
}

describe("ordersHqService.create", () => {
  test("creates an already-approved hq order owned by the caller", async () => {
    const pId = await fixture.createProduct();

    const result = await createOrder([{ pId, amount: 4 }]);

    expect(result.orderType).toBe("hq");
    // HQ has no approval step — the same hq userType would create and approve
    // it, so it lands approved and the stock is usable immediately.
    expect(result.status).toBe("approved");
    expect(result.userId).toBe(fixture.hqUser.id);
    expect(result.approvedBy).toBe(fixture.hqUser.id);
    expect(result.approvedAt).toBeInstanceOf(Date);
  });

  test("persists one head_order_detail row per requested item", async () => {
    const pId = await fixture.createProduct();
    const expiredDate = daysFromNow(45);

    const result = await createOrder([
      {
        pId,
        amount: 6,
        expiredDate: expiredDate.toISOString(),
        basePrice: 25,
      },
    ]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      pId,
      supplierId: fixture.supplierId,
      amount: 6,
      // nothing has been drawn from a brand new HQ lot yet
      remain: 6,
      basePrice: 25,
    });
    expect(result.items[0].expiredDate).toEqual(expiredDate);
    // the line item view omits lotId — it's already on the order above it
    expect(result.items[0]).not.toHaveProperty("lotId");

    const persisted = await db
      .select()
      .from(headOrderDetail)
      .where(eq(headOrderDetail.lotId, result.lotId));

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      pId,
      supplierId: fixture.supplierId,
      amount: 6,
      remain: 6,
      basePrice: 25,
    });
  });

  test("creates one line per requested product", async () => {
    const firstPId = await fixture.createProduct();
    const secondPId = await fixture.createProduct();

    const result = await createOrder([
      { pId: firstPId, amount: 2, basePrice: 10 },
      { pId: secondPId, amount: 3, basePrice: 20 },
    ]);

    expect(result.items).toHaveLength(2);
    expect(result.items.find(({ pId }) => pId === firstPId)).toMatchObject({
      amount: 2,
      basePrice: 10,
    });
    expect(result.items.find(({ pId }) => pId === secondPId)).toMatchObject({
      amount: 3,
      basePrice: 20,
    });
  });

  test("throws AppError(NOT_FOUND) when a pId does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(product.pId) })
      .from(product);
    const missingPId = (highest ?? 0) + 1000;

    const error = await expectAppError(createOrder([{ pId: missingPId }]));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
    expect(error.context).toMatchObject({ pId: missingPId });
  });

  test("throws AppError(NOT_FOUND) for a deactivated product", async () => {
    const pId = await fixture.createProduct({ isActive: false });

    const error = await expectAppError(createOrder([{ pId }]));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
  });

  test("throws AppError(NOT_FOUND) when a supplierId does not exist", async () => {
    const pId = await fixture.createProduct();
    const missingSupplierId = await unusedSupplierId();

    const error = await expectAppError(
      createOrder([{ pId, supplierId: missingSupplierId }]),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
    expect(error.context).toMatchObject({
      message: "supplier not found",
      supplierId: missingSupplierId,
    });
  });

  test("writes no order at all when one item in the request fails", async () => {
    const knownPId = await fixture.createProduct();
    const [{ highest }] = await db
      .select({ highest: max(product.pId) })
      .from(product);
    const missingPId = (highest ?? 0) + 1000;

    const ordersBefore = await countHqOrders();

    await expectAppError(
      createOrder([{ pId: knownPId, amount: 1 }, { pId: missingPId }]),
    );

    // the good line can't land on its own — a rejected request must leave no
    // stock and no order behind
    expect(await countHqOrders()).toBe(ordersBefore);

    const stray = await db
      .select({ total: count() })
      .from(headOrderDetail)
      .where(eq(headOrderDetail.pId, knownPId));

    expect(stray[0].total).toBe(0);
  });
});

describe("ordersHqService.create — min_stock notifications", () => {
  test("resolves the open HQ alert once the restock clears minStockHq", async () => {
    const pId = await fixture.createProduct({ minStockHq: 10 });
    await fixture.createHqStock({ pId, remain: 2 });
    const notificationId = await fixture.createMinStockNotification({
      pId,
      quantity: 2,
    });

    await createOrder([{ pId, amount: 20 }]);

    const resolved = await fixture.getNotification(notificationId);

    expect(resolved.isResolved).toBe(true);
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
  });

  test("counts stock HQ already had toward the threshold", async () => {
    const pId = await fixture.createProduct({ minStockHq: 10 });
    // 8 on hand was under the threshold, so the alert was open
    await fixture.createHqStock({ pId, remain: 8 });
    const notificationId = await fixture.createMinStockNotification({
      pId,
      quantity: 8,
    });

    // 2 more only clears 10 when the 8 already in HQ counts too
    await createOrder([{ pId, amount: 2 }]);

    const resolved = await fixture.getNotification(notificationId);

    expect(resolved.isResolved).toBe(true);
  });

  test("resolves when the restock lands exactly on minStockHq", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    const notificationId = await fixture.createMinStockNotification({ pId });

    await createOrder([{ pId, amount: 5 }]);

    const resolved = await fixture.getNotification(notificationId);

    expect(resolved.isResolved).toBe(true);
  });

  test("leaves the alert open when the restock is still short", async () => {
    const pId = await fixture.createProduct({ minStockHq: 10 });
    await fixture.createHqStock({ pId, remain: 3 });
    const notificationId = await fixture.createMinStockNotification({
      pId,
      quantity: 3,
    });

    // 3 + 4 = 7, still under 10
    await createOrder([{ pId, amount: 4 }]);

    const untouched = await fixture.getNotification(notificationId);

    expect(untouched.isResolved).toBe(false);
    expect(untouched.resolvedAt).toBeNull();
  });

  test("resolves each restocked product's own alert, and only those", async () => {
    const restockedPId = await fixture.createProduct({ minStockHq: 5 });
    const untouchedPId = await fixture.createProduct({ minStockHq: 5 });
    const restockedAlert = await fixture.createMinStockNotification({
      pId: restockedPId,
    });
    const untouchedAlert = await fixture.createMinStockNotification({
      pId: untouchedPId,
    });

    await createOrder([{ pId: restockedPId, amount: 9 }]);

    expect((await fixture.getNotification(restockedAlert)).isResolved).toBe(
      true,
    );
    // nothing was ordered for this one, so its alert still stands
    expect((await fixture.getNotification(untouchedAlert)).isResolved).toBe(
      false,
    );
  });

  test("leaves a branch-scoped alert for the same product alone", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    const hqAlert = await fixture.createMinStockNotification({ pId });
    const branchAlert = await fixture.createMinStockNotification({
      pId,
      branchId: fixture.branchId,
    });

    await createOrder([{ pId, amount: 9 }]);

    expect((await fixture.getNotification(hqAlert)).isResolved).toBe(true);
    // stock landing in HQ says nothing about what's on the branch's shelves
    expect((await fixture.getNotification(branchAlert)).isResolved).toBe(false);
  });

  test("leaves an expire alert for the same product alone", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    const { lotId } = await fixture.createHqStock({ pId, remain: 1 });
    const expireAlert = await fixture.createExpireNotification({ pId, lotId });

    await createOrder([{ pId, amount: 9 }]);

    // a lot still expires on its own date no matter how much arrives after it
    expect((await fixture.getNotification(expireAlert)).isResolved).toBe(false);
  });

  test("keeps the original resolvedAt of an already-resolved alert", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    const resolvedAt = daysFromNow(-3);
    const notificationId = await fixture.createMinStockNotification({
      pId,
      isResolved: true,
      resolvedAt,
    });

    await createOrder([{ pId, amount: 9 }]);

    const untouched = await fixture.getNotification(notificationId);

    expect(untouched.isResolved).toBe(true);
    // re-stamping a closed alert would rewrite when it was actually cleared
    expect(untouched.resolvedAt).toEqual(resolvedAt);
  });

  test("succeeds when the product has no open alert at all", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });

    const result = await createOrder([{ pId, amount: 9 }]);

    expect(result.items).toHaveLength(1);
  });

  test("resolves nothing when the failed request rolls back", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    const notificationId = await fixture.createMinStockNotification({ pId });
    const [{ highest }] = await db
      .select({ highest: max(product.pId) })
      .from(product);

    await expectAppError(
      createOrder([{ pId, amount: 9 }, { pId: (highest ?? 0) + 1000 }]),
    );

    const untouched = await fixture.getNotification(notificationId);

    // the stock that would have cleared the alert never landed
    expect(untouched.isResolved).toBe(false);
    expect(untouched.resolvedAt).toBeNull();
  });
});
