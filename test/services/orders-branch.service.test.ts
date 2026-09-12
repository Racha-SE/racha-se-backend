import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq, max } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branchOrderDetail,
  headOrderDetail,
  order,
  product,
} from "@/db/schema";
import type { OrdersBranchCreateResponse } from "@/models/orders-branch.model";
import { ordersBranchService } from "@/services/orders-branch.service";
import { AppError } from "@/utils";
import {
  daysFromNow,
  type OrdersBranchFixture,
  setupOrdersBranchFixture,
} from "../helpers/orders-branch";

let fixture: OrdersBranchFixture;

beforeAll(async () => {
  fixture = await setupOrdersBranchFixture("svcbranchorder");
});

afterAll(async () => {
  await fixture.cleanup();
});

function createOrder(
  items: { pId: number; amount: number }[],
): Promise<OrdersBranchCreateResponse> {
  return ordersBranchService.create(fixture.branchUser.id, fixture.branchId, {
    items,
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

async function countBranchOrders(): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(order)
    .where(
      and(
        eq(order.userId, fixture.branchUser.id),
        eq(order.orderType, "branch"),
      ),
    );

  return row.total;
}

describe("ordersBranchService.create", () => {
  test("creates a pending branch order and persists one line per requested item", async () => {
    const pId = await fixture.createProduct(15);

    const result = await createOrder([{ pId, amount: 4 }]);

    expect(result.orderType).toBe("branch");
    expect(result.status).toBe("pending");
    expect(result.userId).toBe(fixture.branchUser.id);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      pId,
      branchId: fixture.branchId,
      amount: 4,
      // a pending request is not branch stock, and the lot it will be filled
      // from isn't picked yet, so remain/basePrice/expiredDate stay empty
      remain: 0,
      costPrice: 15,
      basePrice: 0,
    });
    expect(result.items[0].expiredDate).toBeNull();
    // createResponse omits lotId from the line items — it's already on the
    // order the items hang off.
    expect(result.items[0]).not.toHaveProperty("lotId");

    const persisted = await db
      .select()
      .from(branchOrderDetail)
      .where(eq(branchOrderDetail.lotId, result.lotId));

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      pId,
      branchId: fixture.branchId,
      amount: 4,
      remain: 0,
    });
  });

  test("creates one line per requested product", async () => {
    const firstPId = await fixture.createProduct(10);
    const secondPId = await fixture.createProduct(20);

    const result = await createOrder([
      { pId: firstPId, amount: 2 },
      { pId: secondPId, amount: 3 },
    ]);

    expect(result.items).toHaveLength(2);
    expect(result.items.find(({ pId }) => pId === firstPId)).toMatchObject({
      amount: 2,
      costPrice: 10,
    });
    expect(result.items.find(({ pId }) => pId === secondPId)).toMatchObject({
      amount: 3,
      costPrice: 20,
    });
  });

  test("records a request HQ cannot cover, stock permitting or not", async () => {
    const pId = await fixture.createProduct();
    // one lot holding 2, against a request for 30 — and the request stands:
    // whether HQ can cover it is approve's call, not create's
    await fixture.createHqLot({ pId, remain: 2, expiredDate: daysFromNow(30) });

    const result = await createOrder([{ pId, amount: 30 }]);

    expect(result.status).toBe("pending");
    expect(result.items[0].amount).toBe(30);
  });

  test("records a request for a product HQ has no lot for at all", async () => {
    const pId = await fixture.createProduct();

    const result = await createOrder([{ pId, amount: 5 }]);

    expect(result.items[0].amount).toBe(5);
  });

  test("leaves headOrderDetail.remain untouched", async () => {
    const pId = await fixture.createProduct();
    const { lotId } = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    await createOrder([{ pId, amount: 4 }]);

    const [lot] = await db
      .select()
      .from(headOrderDetail)
      .where(eq(headOrderDetail.lotId, lotId));

    // nothing is reserved at request time — the lot is drawn down when HQ
    // approves, which is also what lets approve report INSUFFICIENT_STOCK
    expect(lot.remain).toBe(10);
  });

  test("throws AppError(NOT_FOUND) when a pId does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(product.pId) })
      .from(product);
    const missingPId = (highest ?? 0) + 1000;

    const error = await expectAppError(
      createOrder([{ pId: missingPId, amount: 1 }]),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
  });

  test("throws AppError(NOT_FOUND) for a deactivated product", async () => {
    const pId = await fixture.createProduct();
    await db
      .update(product)
      .set({ isActive: false })
      .where(eq(product.pId, pId));

    const error = await expectAppError(createOrder([{ pId, amount: 1 }]));

    expect(error.code).toBe("NOT_FOUND");
  });

  test("writes no order at all when one item in the request fails", async () => {
    const coveredPId = await fixture.createProduct();
    const [{ highest }] = await db
      .select({ highest: max(product.pId) })
      .from(product);
    const missingPId = (highest ?? 0) + 1000;

    const ordersBefore = await countBranchOrders();

    await expectAppError(
      createOrder([
        { pId: coveredPId, amount: 1 },
        { pId: missingPId, amount: 5 },
      ]),
    );

    expect(await countBranchOrders()).toBe(ordersBefore);

    // the good item's line has to roll back with the order — a rejected
    // request must not leave half of itself behind
    const orphaned = await db
      .select()
      .from(branchOrderDetail)
      .where(eq(branchOrderDetail.pId, coveredPId));

    expect(orphaned).toHaveLength(0);
  });
});
