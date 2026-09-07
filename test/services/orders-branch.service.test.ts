import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq, inArray, max } from "drizzle-orm";
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

// ordersBranchService.create is still a stub returning `null` — this suite is
// the spec it has to satisfy, so the result is read through the response type
// the route already documents. Drop the assertion once create returns for
// real and the types line up on their own.
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
    const expiredDate = daysFromNow(30);
    await fixture.createHqLot({ pId, remain: 10, expiredDate, basePrice: 40 });

    const result = await createOrder([{ pId, amount: 4 }]);

    expect(result.orderType).toBe("branch");
    expect(result.status).toBe("pending");
    expect(result.userId).toBe(fixture.branchUser.id);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      pId,
      branchId: fixture.branchId,
      amount: 4,
      // nothing's been drawn from the branch's own lot yet
      remain: 4,
      costPrice: 15,
      basePrice: 40,
    });
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
      remain: 4,
    });
  });

  test("creates one line per requested product", async () => {
    const firstPId = await fixture.createProduct(10);
    const secondPId = await fixture.createProduct(20);
    await fixture.createHqLot({
      pId: firstPId,
      remain: 5,
      expiredDate: daysFromNow(30),
    });
    await fixture.createHqLot({
      pId: secondPId,
      remain: 5,
      expiredDate: daysFromNow(30),
    });

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

  test("takes expiredDate and basePrice from the nearest-to-expiry approved lot", async () => {
    const pId = await fixture.createProduct();
    const nearest = daysFromNow(10);
    // inserted newest-expiry first, so picking the right lot can't be an
    // accident of insertion order
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(60),
      basePrice: 55,
    });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: nearest,
      basePrice: 40,
    });

    const result = await createOrder([{ pId, amount: 2 }]);

    expect(result.items[0].basePrice).toBe(40);
    expect(result.items[0].expiredDate).toEqual(nearest);
  });

  test("pools available stock across every eligible lot, staying one line", async () => {
    const pId = await fixture.createProduct();
    const nearest = daysFromNow(10);
    await fixture.createHqLot({
      pId,
      remain: 3,
      expiredDate: nearest,
      basePrice: 40,
    });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(60),
      basePrice: 55,
    });

    // 5 outgrows the nearest lot's 3, so it has to reach into the second one
    const result = await createOrder([{ pId, amount: 5 }]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      amount: 5,
      remain: 5,
      basePrice: 40,
    });
    expect(result.items[0].expiredDate).toEqual(nearest);
  });

  test("accepts a request for exactly the total available stock", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({ pId, remain: 2, expiredDate: daysFromNow(10) });
    await fixture.createHqLot({ pId, remain: 3, expiredDate: daysFromNow(20) });

    const result = await createOrder([{ pId, amount: 5 }]);

    expect(result.items[0].amount).toBe(5);
  });

  test("deducts headOrderDetail.remain", async () => {
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

    // requesting draws the lot down right away, so nobody else's order can
    // see those 4 — branch_order_allocation is what puts them back on reject
    expect(lot.remain).toBe(6);
  });

  test("draws stock down lot by lot, nearest expiry first", async () => {
    const pId = await fixture.createProduct();
    const nearest = await fixture.createHqLot({
      pId,
      remain: 3,
      expiredDate: daysFromNow(10),
    });
    const later = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(60),
    });

    // 5 outgrows the nearest lot's 3, so 2 have to come off the later one
    await createOrder([{ pId, amount: 5 }]);

    const lots = await db
      .select()
      .from(headOrderDetail)
      .where(inArray(headOrderDetail.lotId, [nearest.lotId, later.lotId]));
    const byLotId = new Map(lots.map((lot) => [lot.lotId, lot]));

    expect(byLotId.get(nearest.lotId)).toMatchObject({ remain: 0 });
    expect(byLotId.get(later.lotId)).toMatchObject({ remain: 8 });
  });

  test("ignores stock an earlier order already drew", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    // an earlier branch order took 8 of the 10, so only 2 are left to draw
    await createOrder([{ pId, amount: 8 }]);

    const error = await expectAppError(createOrder([{ pId, amount: 3 }]));

    expect(error.code).toBe("INSUFFICIENT_STOCK");
  });

  test("draws the last of a partly drawn lot", async () => {
    const pId = await fixture.createProduct();
    const { lotId } = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    await createOrder([{ pId, amount: 8 }]);

    const result = await createOrder([{ pId, amount: 2 }]);

    expect(result.items[0].amount).toBe(2);

    const [lot] = await db
      .select()
      .from(headOrderDetail)
      .where(eq(headOrderDetail.lotId, lotId));

    expect(lot.remain).toBe(0);
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

  test("throws AppError(INSUFFICIENT_STOCK) when every lot combined is short", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({ pId, remain: 2, expiredDate: daysFromNow(10) });
    await fixture.createHqLot({ pId, remain: 3, expiredDate: daysFromNow(20) });

    const error = await expectAppError(createOrder([{ pId, amount: 6 }]));

    expect(error.code).toBe("INSUFFICIENT_STOCK");
    expect(error.httpStatus).toBe(409);
  });

  test("ignores lots whose order has not been approved", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({ pId, remain: 2, expiredDate: daysFromNow(30) });
    await fixture.createHqLot({
      pId,
      remain: 100,
      expiredDate: daysFromNow(30),
      status: "pending",
    });
    await fixture.createHqLot({
      pId,
      remain: 100,
      expiredDate: daysFromNow(30),
      status: "rejected",
    });

    // only the approved lot's 2 counts, so 3 can't be covered
    const error = await expectAppError(createOrder([{ pId, amount: 3 }]));

    expect(error.code).toBe("INSUFFICIENT_STOCK");
  });

  test("ignores lots that have already expired", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({ pId, remain: 2, expiredDate: daysFromNow(30) });
    await fixture.createHqLot({
      pId,
      remain: 100,
      expiredDate: daysFromNow(-1),
    });

    const error = await expectAppError(createOrder([{ pId, amount: 3 }]));

    expect(error.code).toBe("INSUFFICIENT_STOCK");
  });

  test("writes no order at all when one item in the request fails", async () => {
    const coveredPId = await fixture.createProduct();
    const shortPId = await fixture.createProduct();
    const covered = await fixture.createHqLot({
      pId: coveredPId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    await fixture.createHqLot({
      pId: shortPId,
      remain: 1,
      expiredDate: daysFromNow(30),
    });

    const ordersBefore = await countBranchOrders();

    await expectAppError(
      createOrder([
        { pId: coveredPId, amount: 1 },
        { pId: shortPId, amount: 5 },
      ]),
    );

    expect(await countBranchOrders()).toBe(ordersBefore);

    // the covered item's deduction has to roll back with the order —
    // otherwise a failed request quietly eats stock nobody ordered
    const [coveredLot] = await db
      .select()
      .from(headOrderDetail)
      .where(eq(headOrderDetail.lotId, covered.lotId));

    expect(coveredLot.remain).toBe(10);
  });
});
