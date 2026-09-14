import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq, isNull, max } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branchOrderDetail,
  headOrderDetail,
  notification,
  order,
  product,
} from "@/db/schema";
import type {
  OrdersBranchApproveResponse,
  OrdersBranchCreateResponse,
  OrdersBranchRejectResponse,
} from "@/models/orders-branch.model";
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

function approveOrder(lotId: number): Promise<OrdersBranchApproveResponse> {
  return ordersBranchService.approve(lotId, fixture.hqUser.id);
}

function rejectOrder(lotId: number): Promise<OrdersBranchRejectResponse> {
  return ordersBranchService.reject(lotId);
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected the call to throw an AppError, but it resolved");
}

async function lotById(lotId: number) {
  const [lot] = await db
    .select()
    .from(headOrderDetail)
    .where(eq(headOrderDetail.lotId, lotId));

  return lot;
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

describe("ordersBranchService.approve", () => {
  test("approves the order and fills each line from the HQ lot that covers it", async () => {
    const pId = await fixture.createProduct(15);
    const expiredDate = daysFromNow(30);
    const { lotId: hqLotId } = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate,
      basePrice: 40,
    });
    const requested = await createOrder([{ pId, amount: 4 }]);

    const result = await approveOrder(requested.lotId);

    expect(result.status).toBe("approved");
    expect(result.approvedBy).toBe(fixture.hqUser.id);
    expect(result.approvedAt).not.toBeNull();

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      pId,
      amount: 4,
      // the branch holds these now, priced and dated by the lot they came from
      remain: 4,
      basePrice: 40,
      costPrice: 15,
    });
    expect(result.items[0].expiredDate).toEqual(expiredDate);

    // and HQ is down the same 4
    expect((await lotById(hqLotId)).remain).toBe(6);
  });

  test("draws stock down lot by lot, nearest expiry first", async () => {
    const pId = await fixture.createProduct();
    const nearest = await fixture.createHqLot({
      pId,
      remain: 3,
      expiredDate: daysFromNow(10),
      basePrice: 40,
    });
    const later = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(60),
      basePrice: 55,
    });
    const requested = await createOrder([{ pId, amount: 5 }]);

    // 5 outgrows the nearest lot's 3, so 2 have to come off the later one
    const result = await approveOrder(requested.lotId);

    expect((await lotById(nearest.lotId)).remain).toBe(0);
    expect((await lotById(later.lotId)).remain).toBe(8);

    // the line stays one row, carrying the nearest lot's expiry and price
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ amount: 5, remain: 5 });
  });

  test("throws AppError(NOT_FOUND) for a lotId that does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(order.lotId) })
      .from(order);

    const error = await expectAppError(approveOrder((highest ?? 0) + 1000));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
  });

  test("throws AppError(NOT_FOUND) for an HQ order's lotId", async () => {
    const pId = await fixture.createProduct();
    const { lotId } = await fixture.createHqLot({
      pId,
      remain: 5,
      expiredDate: daysFromNow(30),
    });

    const error = await expectAppError(approveOrder(lotId));

    expect(error.code).toBe("NOT_FOUND");
  });

  test("throws AppError(INSUFFICIENT_STOCK) when HQ can no longer cover the request", async () => {
    const pId = await fixture.createProduct();
    const { lotId: hqLotId } = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const requested = await createOrder([{ pId, amount: 8 }]);
    // another order got approved first and took what this one was counting on
    const earlier = await createOrder([{ pId, amount: 8 }]);
    await approveOrder(earlier.lotId);

    const error = await expectAppError(approveOrder(requested.lotId));

    expect(error.code).toBe("INSUFFICIENT_STOCK");
    expect(error.httpStatus).toBe(409);

    // the failed approval leaves both the order and the lot exactly as it
    // found them
    const [stillPending] = await db
      .select()
      .from(order)
      .where(eq(order.lotId, requested.lotId));

    expect(stillPending.status).toBe("pending");
    expect((await lotById(hqLotId)).remain).toBe(2);
  });

  test("ignores lots that are expired or whose HQ order is not approved", async () => {
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
      expiredDate: daysFromNow(-1),
    });
    const requested = await createOrder([{ pId, amount: 3 }]);

    // only the approved, unexpired lot's 2 counts
    const error = await expectAppError(approveOrder(requested.lotId));

    expect(error.code).toBe("INSUFFICIENT_STOCK");
  });

  test("writes nothing when one line of a multi-line order is short", async () => {
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
    const requested = await createOrder([
      { pId: coveredPId, amount: 1 },
      { pId: shortPId, amount: 5 },
    ]);

    await expectAppError(approveOrder(requested.lotId));

    // the covered line's deduction has to roll back with the approval —
    // otherwise a rejected approval quietly eats stock nobody received
    expect((await lotById(covered.lotId)).remain).toBe(10);

    const lines = await db
      .select()
      .from(branchOrderDetail)
      .where(eq(branchOrderDetail.lotId, requested.lotId));

    expect(lines.every((line) => line.remain === 0)).toBe(true);
    expect(lines.every((line) => line.expiredDate === null)).toBe(true);
  });

  test("throws AppError(BAD_REQUEST) when the order is no longer pending", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const requested = await createOrder([{ pId, amount: 2 }]);
    await approveOrder(requested.lotId);

    const error = await expectAppError(approveOrder(requested.lotId));

    expect(error.code).toBe("BAD_REQUEST");
    expect(error.httpStatus).toBe(400);
  });

  test("does not draw the same stock twice when approved twice", async () => {
    const pId = await fixture.createProduct();
    const { lotId: hqLotId } = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const requested = await createOrder([{ pId, amount: 4 }]);

    await approveOrder(requested.lotId);
    await expectAppError(approveOrder(requested.lotId));

    expect((await lotById(hqLotId)).remain).toBe(6);
  });
});

describe("ordersBranchService.reject", () => {
  test("marks the order rejected and returns it with its line items", async () => {
    const pId = await fixture.createProduct(15);
    const { lotId: hqLotId } = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const requested = await createOrder([{ pId, amount: 4 }]);

    const result = await rejectOrder(requested.lotId);

    expect(result.lotId).toBe(requested.lotId);
    expect(result.status).toBe("rejected");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ pId, amount: 4, remain: 0 });
    // a rejected request never held any stock, so there's nothing to give
    // back — the lot is untouched either way
    expect((await lotById(hqLotId)).remain).toBe(10);
  });

  test("throws AppError(NOT_FOUND) for a lotId that does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(order.lotId) })
      .from(order);

    const error = await expectAppError(rejectOrder((highest ?? 0) + 1000));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
  });

  test("throws AppError(NOT_FOUND) for an HQ order's lotId", async () => {
    const pId = await fixture.createProduct();
    const { lotId } = await fixture.createHqLot({
      pId,
      remain: 5,
      expiredDate: daysFromNow(30),
    });

    const error = await expectAppError(rejectOrder(lotId));

    expect(error.code).toBe("NOT_FOUND");
  });

  test("throws AppError(BAD_REQUEST) for an order that was already approved", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const requested = await createOrder([{ pId, amount: 2 }]);
    await approveOrder(requested.lotId);

    const error = await expectAppError(rejectOrder(requested.lotId));

    expect(error.code).toBe("BAD_REQUEST");
    expect(error.httpStatus).toBe(400);
  });

  test("throws AppError(BAD_REQUEST) when rejected twice", async () => {
    const pId = await fixture.createProduct();
    const requested = await createOrder([{ pId, amount: 2 }]);
    await rejectOrder(requested.lotId);

    const error = await expectAppError(rejectOrder(requested.lotId));

    expect(error.code).toBe("BAD_REQUEST");
  });

  test("cannot be approved after it has been rejected", async () => {
    const pId = await fixture.createProduct();
    const { lotId: hqLotId } = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const requested = await createOrder([{ pId, amount: 4 }]);
    await rejectOrder(requested.lotId);

    const error = await expectAppError(approveOrder(requested.lotId));

    expect(error.code).toBe("BAD_REQUEST");
    expect((await lotById(hqLotId)).remain).toBe(10);
  });
});

/**
 * A branch order in the state receipt starts from: requested by the branch,
 * approved by HQ. `approve()` is still a stub, so the fixture puts the order
 * there directly rather than the test walking a route that doesn't work yet.
 */
async function approvedOrder(
  items: { pId: number; amount: number }[],
): Promise<OrdersBranchCreateResponse> {
  const created = await createOrder(items);
  await approveOrder(created.lotId);

  return created;
}

async function readOrder(lotId: number) {
  const [row] = await db.select().from(order).where(eq(order.lotId, lotId));

  return row;
}

async function readHqLot(lotId: number) {
  const [row] = await db
    .select()
    .from(headOrderDetail)
    .where(eq(headOrderDetail.lotId, lotId));

  return row;
}

/** min_stock alerts for one product in one scope — branchId null is HQ's. */
function readMinStockAlerts(pId: number, branchId: number | null) {
  return db
    .select()
    .from(notification)
    .where(
      and(
        eq(notification.type, "min_stock"),
        eq(notification.pId, pId),
        branchId === null
          ? isNull(notification.branchId)
          : eq(notification.branchId, branchId),
      ),
    );
}

describe("ordersBranchService.receive", () => {
  test("completes the order and records when it arrived", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await approvedOrder([{ pId, amount: 4 }]);

    const before = new Date();
    await ordersBranchService.receive(created.lotId, fixture.branchId);

    const received = await readOrder(created.lotId);
    expect(received.status).toBe("completed");
    expect(received.receivedAt).not.toBeNull();
    expect(received.receivedAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  });

  test("leaves HQ down by exactly the amount received", async () => {
    const pId = await fixture.createProduct();
    const { lotId } = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await approvedOrder([{ pId, amount: 4 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    // 4 of the 10 moved to the branch, so 6 stay at HQ — receiving must not
    // take a second 4 off the lot the request already reserved
    expect((await readHqLot(lotId)).remain).toBe(6);
  });

  test("leaves every lot the order was filled from down by its share", async () => {
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
    const created = await approvedOrder([{ pId, amount: 5 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    // 5 across two lots: all 3 of the nearest, 2 off the later one
    expect((await readHqLot(nearest.lotId)).remain).toBe(0);
    expect((await readHqLot(later.lotId)).remain).toBe(8);
  });

  test("the received line holds the quantity, expiry and prices of what arrived", async () => {
    const pId = await fixture.createProduct(15);
    const expiredDate = daysFromNow(30);
    await fixture.createHqLot({ pId, remain: 10, expiredDate, basePrice: 40 });
    const created = await approvedOrder([{ pId, amount: 4 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    const lines = await db
      .select()
      .from(branchOrderDetail)
      .where(eq(branchOrderDetail.lotId, created.lotId));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      pId,
      branchId: fixture.branchId,
      amount: 4,
      // nothing has been sold out of it yet, so all 4 are on the shelf
      remain: 4,
      costPrice: 15,
      basePrice: 40,
    });
    expect(lines[0].expiredDate).toEqual(expiredDate);
  });

  test("refuses a caller with no branch", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await approvedOrder([{ pId, amount: 1 }]);

    // wrapped in a call because this guard runs before receive opens its
    // transaction — it throws where every other failure rejects
    const error = await expectAppError(
      (async () => ordersBranchService.receive(created.lotId))(),
    );

    expect(error.code).toBe("BAD_REQUEST");
    expect(error.httpStatus).toBe(400);
  });

  test("refuses a branch receiving another branch's order, and changes nothing", async () => {
    const pId = await fixture.createProduct();
    const { lotId } = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await approvedOrder([{ pId, amount: 4 }]);

    const error = await expectAppError(
      ordersBranchService.receive(created.lotId, fixture.otherBranchId),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(error.httpStatus).toBe(403);
    expect((await readOrder(created.lotId)).status).toBe("approved");
    expect((await readHqLot(lotId)).remain).toBe(6);
  });

  test("throws NOT_FOUND for a lot that doesn't exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(order.lotId) })
      .from(order);

    const error = await expectAppError(
      ordersBranchService.receive((highest ?? 0) + 1000, fixture.branchId),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
  });

  test("refuses an order HQ hasn't approved yet", async () => {
    const pId = await fixture.createProduct();
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    // straight from create — a branch can't sign for a delivery HQ never sent
    const created = await createOrder([{ pId, amount: 4 }]);

    const error = await expectAppError(
      ordersBranchService.receive(created.lotId, fixture.branchId),
    );

    expect(error.code).toBe("BAD_REQUEST");
    expect((await readOrder(created.lotId)).status).toBe("pending");
  });

  test("refuses a second receipt of the same order", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    const { lotId } = await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await approvedOrder([{ pId, amount: 8 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);
    const error = await expectAppError(
      ordersBranchService.receive(created.lotId, fixture.branchId),
    );

    expect(error.code).toBe("BAD_REQUEST");
    // a delivery signed for twice must not move stock or alert twice
    expect((await readHqLot(lotId)).remain).toBe(2);
    expect(await readMinStockAlerts(pId, null)).toHaveLength(1);
  });
});

// Branch stock has no read endpoint yet (inventoryService.getBranchStock is
// still a stub), so what a receipt added to the branch is observed the way the
// spec ties it: against the product's minimums, through the alerts receipt
// opens and clears.
describe("ordersBranchService.receive — min_stock alerts", () => {
  test("clears the branch's alert for a product the delivery restocked", async () => {
    const pId = await fixture.createProduct({ minStockBranch: 5 });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    await fixture.openMinStockNotification({
      pId,
      branchId: fixture.branchId,
      quantity: 0,
    });
    const created = await approvedOrder([{ pId, amount: 5 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    const [alert] = await readMinStockAlerts(pId, fixture.branchId);
    expect(alert.isResolved).toBe(true);
    expect(alert.resolvedAt).not.toBeNull();
  });

  test("keeps the branch's alert open when the delivery still leaves it short", async () => {
    const pId = await fixture.createProduct({ minStockBranch: 5 });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    await fixture.openMinStockNotification({
      pId,
      branchId: fixture.branchId,
      quantity: 0,
    });
    // 2 against a minimum of 5 — the branch is still below it
    const created = await approvedOrder([{ pId, amount: 2 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    const [alert] = await readMinStockAlerts(pId, fixture.branchId);
    expect(alert.isResolved).toBe(false);
    expect(alert.resolvedAt).toBeNull();
  });

  test("counts stock from earlier deliveries toward the branch's minimum", async () => {
    const pId = await fixture.createProduct({ minStockBranch: 5 });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    await fixture.openMinStockNotification({
      pId,
      branchId: fixture.branchId,
      quantity: 0,
    });

    const first = await approvedOrder([{ pId, amount: 2 }]);
    await ordersBranchService.receive(first.lotId, fixture.branchId);

    // 3 more on top of the 2 already on the shelf reaches the minimum of 5
    const second = await approvedOrder([{ pId, amount: 3 }]);
    await ordersBranchService.receive(second.lotId, fixture.branchId);

    const [alert] = await readMinStockAlerts(pId, fixture.branchId);
    expect(alert.isResolved).toBe(true);
  });

  test("leaves another branch's alert for the same product open", async () => {
    const pId = await fixture.createProduct({ minStockBranch: 5 });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    await fixture.openMinStockNotification({
      pId,
      branchId: fixture.otherBranchId,
      quantity: 0,
    });
    const created = await approvedOrder([{ pId, amount: 5 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    // the other branch's shelves didn't get any of this delivery
    const [alert] = await readMinStockAlerts(pId, fixture.otherBranchId);
    expect(alert.isResolved).toBe(false);
  });

  test("leaves alerts for products the delivery didn't include open", async () => {
    const deliveredPId = await fixture.createProduct({ minStockBranch: 5 });
    const untouchedPId = await fixture.createProduct({ minStockBranch: 5 });
    await fixture.createHqLot({
      pId: deliveredPId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    await fixture.openMinStockNotification({
      pId: untouchedPId,
      branchId: fixture.branchId,
      quantity: 0,
    });
    const created = await approvedOrder([{ pId: deliveredPId, amount: 5 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    const [alert] = await readMinStockAlerts(untouchedPId, fixture.branchId);
    expect(alert.isResolved).toBe(false);
  });

  test("raises an HQ alert when the delivery takes HQ below its minimum", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    // 8 of the 10 go to the branch, leaving HQ with 2 against a minimum of 5
    const created = await approvedOrder([{ pId, amount: 8 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    const alerts = await readMinStockAlerts(pId, null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: "min_stock",
      branchId: null,
      quantity: 2,
      isResolved: false,
    });
  });

  test("raises no HQ alert while HQ still holds its minimum", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    // 6 left of the 10 — still at or above the minimum of 5
    const created = await approvedOrder([{ pId, amount: 4 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    expect(await readMinStockAlerts(pId, null)).toHaveLength(0);
  });

  test("keeps the open HQ alert rather than raising a second one", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    await fixture.openMinStockNotification({ pId, quantity: 9 });
    const created = await approvedOrder([{ pId, amount: 8 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    const alerts = await readMinStockAlerts(pId, null);
    expect(alerts).toHaveLength(1);
    // the quantity on an alert is the level when it was raised, not a live one
    expect(alerts[0].quantity).toBe(9);
  });

  test("doesn't count expired HQ stock as cover for the minimum", async () => {
    const pId = await fixture.createProduct({ minStockHq: 5 });
    await fixture.createHqLot({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    // plenty on paper, but none of it can be sent anywhere
    await fixture.createHqLot({
      pId,
      remain: 100,
      expiredDate: daysFromNow(-1),
    });
    const created = await approvedOrder([{ pId, amount: 8 }]);

    await ordersBranchService.receive(created.lotId, fixture.branchId);

    const alerts = await readMinStockAlerts(pId, null);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].quantity).toBe(2);
  });
});
