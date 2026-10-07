import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq, isNull, max } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branchOrderDetail,
  customerOrderDetail,
  notification,
  order,
  product,
} from "@/db/schema";
import type {
  OrdersCustomerCancelResponse,
  OrdersCustomerConfirmPaymentResponse,
  OrdersCustomerCreateResponse,
} from "@/models/orders-customer.model";
import { ordersCustomerService } from "@/services/orders-customer.service";
import { AppError } from "@/utils";
import {
  daysFromNow,
  type OrdersCustomerFixture,
  setupOrdersCustomerFixture,
} from "../helpers/orders-customer";

let fixture: OrdersCustomerFixture;

beforeAll(async () => {
  fixture = await setupOrdersCustomerFixture("svccustomerorder");
});

afterAll(async () => {
  await fixture.cleanup();
});

function createOrder(
  paymentMethod: "cash" | "qr",
  items: { pId: number; quantity: number }[],
): Promise<OrdersCustomerCreateResponse> {
  return ordersCustomerService.create(
    fixture.cashierUser.id,
    fixture.branchId,
    {
      paymentMethod,
      items,
    },
  );
}

function confirmPayment(
  lotId: number,
): Promise<OrdersCustomerConfirmPaymentResponse> {
  return ordersCustomerService.confirmPayment(lotId);
}

function cancelOrder(
  lotId: number,
  branchId: number = fixture.branchId,
): Promise<OrdersCustomerCancelResponse> {
  return ordersCustomerService.cancel(lotId, branchId);
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

async function lotByBodId(bodId: number) {
  const [lot] = await db
    .select()
    .from(branchOrderDetail)
    .where(eq(branchOrderDetail.bodId, bodId));

  return lot;
}

async function readOrder(lotId: number) {
  const [row] = await db.select().from(order).where(eq(order.lotId, lotId));

  return row;
}

async function readDetails(lotId: number) {
  return db
    .select()
    .from(customerOrderDetail)
    .where(eq(customerOrderDetail.lotId, lotId));
}

async function countCustomerOrders(): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(order)
    .where(
      and(
        eq(order.userId, fixture.cashierUser.id),
        eq(order.orderType, "customer"),
      ),
    );

  return row.total;
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

describe("ordersCustomerService.create — cash", () => {
  test("decrements branch stock immediately and completes the order", async () => {
    const pId = await fixture.createProduct(10);
    const { bodId } = await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
      basePrice: 25,
    });

    const result = await createOrder("cash", [{ pId, quantity: 4 }]);

    expect(result.orderType).toBe("customer");
    expect(result.status).toBe("completed");
    expect(result.userId).toBe(fixture.cashierUser.id);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ pId, quantity: 4, basePrice: 25 });
    expect(result.items[0]).not.toHaveProperty("lotId");
    expect(result.items[0]).not.toHaveProperty("bodId");
    expect(result).not.toHaveProperty("paymentUrl");

    expect((await lotByBodId(bodId)).remain).toBe(6);
  });

  test("draws stock down lot by lot, nearest expiry first, producing one row per lot", async () => {
    const pId = await fixture.createProduct();
    const nearest = await fixture.createBranchStock({
      pId,
      remain: 3,
      expiredDate: daysFromNow(10),
      basePrice: 20,
    });
    const later = await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(60),
      basePrice: 30,
    });

    const result = await createOrder("cash", [{ pId, quantity: 5 }]);

    expect((await lotByBodId(nearest.bodId)).remain).toBe(0);
    expect((await lotByBodId(later.bodId)).remain).toBe(8);

    // unlike orders-branch's single collapsed row, a multi-lot line becomes
    // two customer_order_detail rows here — one per lot actually drawn from,
    // so cancel can restore each exactly.
    expect(result.items).toHaveLength(2);
    expect(result.items.find((item) => item.basePrice === 20)).toMatchObject({
      quantity: 3,
    });
    expect(result.items.find((item) => item.basePrice === 30)).toMatchObject({
      quantity: 2,
    });
  });

  test("throws INSUFFICIENT_STOCK and rolls back everything when stock is short", async () => {
    const pId = await fixture.createProduct();
    const { bodId } = await fixture.createBranchStock({
      pId,
      remain: 2,
      expiredDate: daysFromNow(30),
    });

    const ordersBefore = await countCustomerOrders();

    const error = await expectAppError(
      createOrder("cash", [{ pId, quantity: 30 }]),
    );

    expect(error.code).toBe("INSUFFICIENT_STOCK");
    expect(error.httpStatus).toBe(409);
    expect(await countCustomerOrders()).toBe(ordersBefore);
    expect((await lotByBodId(bodId)).remain).toBe(2);
  });

  test("throws NOT_FOUND for a pId that does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(product.pId) })
      .from(product);
    const missingPId = (highest ?? 0) + 1000;

    const error = await expectAppError(
      createOrder("cash", [{ pId: missingPId, quantity: 1 }]),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  test("throws NOT_FOUND for a deactivated product", async () => {
    const pId = await fixture.createProduct();
    await db
      .update(product)
      .set({ isActive: false })
      .where(eq(product.pId, pId));

    const error = await expectAppError(
      createOrder("cash", [{ pId, quantity: 1 }]),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  test("opens a branch-scoped (not HQ-scoped) min_stock alert", async () => {
    const pId = await fixture.createProduct({ minStockBranch: 5 });
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    await createOrder("cash", [{ pId, quantity: 8 }]);

    const branchAlerts = await readMinStockAlerts(pId, fixture.branchId);
    expect(branchAlerts).toHaveLength(1);
    expect(branchAlerts[0].isResolved).toBe(false);

    expect(await readMinStockAlerts(pId, null)).toHaveLength(0);
  });
});

describe("ordersCustomerService.create — qr", () => {
  test("decrements branch stock immediately too, but leaves the order pending with a paymentUrl", async () => {
    const pId = await fixture.createProduct();
    const { bodId } = await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });

    const result = await createOrder("qr", [{ pId, quantity: 4 }]);

    expect(result.status).toBe("pending");
    expect(result.paymentUrl).toBe(
      `/api/v1/orders/customer/${result.lotId}/confirm-payment`,
    );
    // the reservation is real — this is the whole point of the redesign
    expect((await lotByBodId(bodId)).remain).toBe(6);
  });

  test("reserving at create blocks a later sale of the same units (no double-sell)", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 1,
      expiredDate: daysFromNow(30),
    });

    const qrOrder = await createOrder("qr", [{ pId, quantity: 1 }]);
    expect(qrOrder.status).toBe("pending");

    // the one unit is already reserved, so a second sale for it must fail
    const error = await expectAppError(
      createOrder("cash", [{ pId, quantity: 1 }]),
    );
    expect(error.code).toBe("INSUFFICIENT_STOCK");
  });

  test("creates no order row at all when stock is short", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 1,
      expiredDate: daysFromNow(30),
    });

    const ordersBefore = await countCustomerOrders();
    await expectAppError(createOrder("qr", [{ pId, quantity: 5 }]));

    expect(await countCustomerOrders()).toBe(ordersBefore);
  });
});

describe("ordersCustomerService.confirmPayment", () => {
  test("only flips the status — stock was already moved at create", async () => {
    const pId = await fixture.createProduct();
    const { bodId } = await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("qr", [{ pId, quantity: 4 }]);
    const remainAfterCreate = (await lotByBodId(bodId)).remain;

    const result = await confirmPayment(created.lotId);

    expect(result.status).toBe("completed");
    expect((await lotByBodId(bodId)).remain).toBe(remainAfterCreate);
  });

  test("throws NOT_FOUND for a lotId that does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(order.lotId) })
      .from(order);

    const error = await expectAppError(confirmPayment((highest ?? 0) + 1000));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
  });

  test("throws BAD_REQUEST when confirming an already-completed (cash) order", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("cash", [{ pId, quantity: 2 }]);

    const error = await expectAppError(confirmPayment(created.lotId));

    expect(error.code).toBe("BAD_REQUEST");
  });

  test("throws BAD_REQUEST when confirming an already-rejected order", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("qr", [{ pId, quantity: 2 }]);
    await cancelOrder(created.lotId);

    const error = await expectAppError(confirmPayment(created.lotId));

    expect(error.code).toBe("BAD_REQUEST");
  });

  test("throws BAD_REQUEST on double-confirm", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("qr", [{ pId, quantity: 2 }]);
    await confirmPayment(created.lotId);

    const error = await expectAppError(confirmPayment(created.lotId));

    expect(error.code).toBe("BAD_REQUEST");
  });
});

describe("ordersCustomerService.cancel", () => {
  test("restores stock to the exact lot(s) originally drawn and rejects the order", async () => {
    const pId = await fixture.createProduct();
    const first = await fixture.createBranchStock({
      pId,
      remain: 3,
      expiredDate: daysFromNow(10),
    });
    const second = await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(60),
    });
    // 5 spans both lots: all 3 of the nearest, 2 off the later one
    const created = await createOrder("qr", [{ pId, quantity: 5 }]);
    expect((await lotByBodId(first.bodId)).remain).toBe(0);
    expect((await lotByBodId(second.bodId)).remain).toBe(8);

    const result = await cancelOrder(created.lotId);

    expect(result.status).toBe("rejected");
    // each lot gets back exactly what it gave up — not the product total
    // dumped on whichever lot a fresh FEFO pass would pick
    expect((await lotByBodId(first.bodId)).remain).toBe(3);
    expect((await lotByBodId(second.bodId)).remain).toBe(10);
  });

  test("re-resolves a min_stock alert the reservation had opened", async () => {
    const pId = await fixture.createProduct({ minStockBranch: 5 });
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("qr", [{ pId, quantity: 8 }]);
    expect(
      (await readMinStockAlerts(pId, fixture.branchId))[0].isResolved,
    ).toBe(false);

    await cancelOrder(created.lotId);

    const [alert] = await readMinStockAlerts(pId, fixture.branchId);
    expect(alert.isResolved).toBe(true);
  });

  test("throws FORBIDDEN when a different branch tries to cancel", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("qr", [{ pId, quantity: 2 }]);

    const error = await expectAppError(
      cancelOrder(created.lotId, fixture.otherBranchId),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect((await readOrder(created.lotId)).status).toBe("pending");
  });

  test("throws BAD_REQUEST cancelling an already-completed (cash) order", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("cash", [{ pId, quantity: 2 }]);

    const error = await expectAppError(cancelOrder(created.lotId));

    expect(error.code).toBe("BAD_REQUEST");
  });

  test("throws BAD_REQUEST cancelling an already-cancelled order", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("qr", [{ pId, quantity: 2 }]);
    await cancelOrder(created.lotId);

    const error = await expectAppError(cancelOrder(created.lotId));

    expect(error.code).toBe("BAD_REQUEST");
  });

  test("throws NOT_FOUND for a lotId that does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(order.lotId) })
      .from(order);

    const error = await expectAppError(cancelOrder((highest ?? 0) + 1000));

    expect(error.code).toBe("NOT_FOUND");
  });
});

describe("ordersCustomerService.list / getById", () => {
  test("scopes a cashier/branch caller to their own branch", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("cash", [{ pId, quantity: 1 }]);

    const result = await ordersCustomerService.getById(
      created.lotId,
      fixture.branchId,
    );
    expect(result.lotId).toBe(created.lotId);

    const list = await ordersCustomerService.list({}, fixture.branchId);
    expect(list.orders.some((o) => o.lotId === created.lotId)).toBe(true);
  });

  test("throws FORBIDDEN when a different branch reads the order", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("cash", [{ pId, quantity: 1 }]);

    const error = await expectAppError(
      ordersCustomerService.getById(created.lotId, fixture.otherBranchId),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  test("a different branch's list never surfaces the order", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
    });
    const created = await createOrder("cash", [{ pId, quantity: 1 }]);

    const otherBranchList = await ordersCustomerService.list(
      {},
      fixture.otherBranchId,
    );
    expect(otherBranchList.orders.some((o) => o.lotId === created.lotId)).toBe(
      false,
    );
  });

  test("throws NOT_FOUND for a lotId that does not exist", async () => {
    const [{ highest }] = await db
      .select({ highest: max(order.lotId) })
      .from(order);

    const error = await expectAppError(
      ordersCustomerService.getById((highest ?? 0) + 1000, fixture.branchId),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  test("surfaces every lot a multi-lot line drew from, not collapsed", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 3,
      expiredDate: daysFromNow(10),
    });
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(60),
    });
    const created = await createOrder("cash", [{ pId, quantity: 5 }]);

    const result = await ordersCustomerService.getById(
      created.lotId,
      fixture.branchId,
    );
    expect(result.items).toHaveLength(2);

    const details = await readDetails(created.lotId);
    expect(details).toHaveLength(2);
  });
});
