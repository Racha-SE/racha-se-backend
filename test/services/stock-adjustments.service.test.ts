import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { branchOrderDetail, notification, stockAdjustment } from "@/db/schema";
import { stockAdjustmentsService } from "@/services/stock-adjustments.service";
import { AppError, type ScopedActor } from "@/utils";
import {
  daysFromNow,
  type OrdersCustomerFixture,
  setupOrdersCustomerFixture,
} from "../helpers/orders-customer";

let fixture: OrdersCustomerFixture;
let branchActor: ScopedActor;

beforeAll(async () => {
  fixture = await setupOrdersCustomerFixture("svcstockadj");
  branchActor = {
    id: fixture.branchUser.id,
    userType: "branch",
    branchId: fixture.branchId,
  };
});

afterAll(async () => {
  await fixture.cleanup();
});

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected the call to throw an AppError, but it resolved");
}

async function readRemain(bodId: number): Promise<number> {
  const [row] = await db
    .select({ remain: branchOrderDetail.remain })
    .from(branchOrderDetail)
    .where(eq(branchOrderDetail.bodId, bodId));
  return row.remain;
}

async function readAdjustments(pId: number) {
  return db.select().from(stockAdjustment).where(eq(stockAdjustment.pId, pId));
}

function adjust(pId: number, quantityChange: number, reason = "count error") {
  return stockAdjustmentsService.create(branchActor, fixture.branchId, {
    pId,
    quantityChange,
    reason,
  });
}

describe("stockAdjustmentsService.create", () => {
  test("a negative change comes off the nearest-expiry lot first", async () => {
    const pId = await fixture.createProduct();
    const nearest = await fixture.createBranchStock({
      pId,
      remain: 3,
      expiredDate: daysFromNow(5),
    });
    const later = await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(60),
    });

    const result = await adjust(pId, -5, "damaged in storage");

    // all 3 of the nearest lot, then 2 off the later one
    expect(await readRemain(nearest.bodId)).toBe(0);
    expect(await readRemain(later.bodId)).toBe(8);
    expect(result).toMatchObject({
      branchId: fixture.branchId,
      pId,
      quantityChange: -5,
      reason: "damaged in storage",
      userId: fixture.branchUser.id,
      onHand: 8,
    });
  });

  test("records who made the adjustment and why", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 4,
      expiredDate: daysFromNow(30),
    });

    await adjust(pId, -1, "dropped a bottle");

    const [record] = await readAdjustments(pId);
    expect(record).toMatchObject({
      branchId: fixture.branchId,
      quantityChange: -1,
      reason: "dropped a bottle",
      userId: fixture.branchUser.id,
    });
  });

  test("a positive change goes onto the newest unexpired lot, even a sold-out one", async () => {
    const pId = await fixture.createProduct();
    const older = await fixture.createBranchStock({
      pId,
      remain: 2,
      expiredDate: daysFromNow(10),
    });
    const newest = await fixture.createBranchStock({
      pId,
      remain: 0,
      expiredDate: daysFromNow(40),
    });

    const result = await adjust(pId, 3, "found a box in the back");

    expect(await readRemain(older.bodId)).toBe(2);
    expect(await readRemain(newest.bodId)).toBe(3);
    expect(result.onHand).toBe(5);
  });

  test("skips expired lots on both sides", async () => {
    const pId = await fixture.createProduct();
    const expired = await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(-1),
    });
    const fresh = await fixture.createBranchStock({
      pId,
      remain: 2,
      expiredDate: daysFromNow(20),
    });

    // only the 2 unexpired units are on hand
    const error = await expectAppError(adjust(pId, -3));
    expect(error.code).toBe("INSUFFICIENT_STOCK");
    expect(error.context).toMatchObject({ requested: 3, availableAmount: 2 });

    await adjust(pId, 1);
    expect(await readRemain(expired.bodId)).toBe(10);
    expect(await readRemain(fresh.bodId)).toBe(3);
  });

  test("refuses to remove more than is on hand, and changes nothing", async () => {
    const pId = await fixture.createProduct();
    const lot = await fixture.createBranchStock({
      pId,
      remain: 2,
      expiredDate: daysFromNow(30),
    });

    const error = await expectAppError(adjust(pId, -5));

    expect(error.code).toBe("INSUFFICIENT_STOCK");
    expect(error.httpStatus).toBe(409);
    expect(await readRemain(lot.bodId)).toBe(2);
    expect(await readAdjustments(pId)).toHaveLength(0);
  });

  test("refuses a positive change for a product the branch never received", async () => {
    const pId = await fixture.createProduct();

    const error = await expectAppError(adjust(pId, 2));

    expect(error.code).toBe("BAD_REQUEST");
    expect(await readAdjustments(pId)).toHaveLength(0);
  });

  test("refuses another branch's stock", async () => {
    const pId = await fixture.createProduct();
    await fixture.createBranchStock({
      pId,
      remain: 5,
      expiredDate: daysFromNow(30),
    });

    const error = await expectAppError(
      stockAdjustmentsService.create(branchActor, fixture.otherBranchId, {
        pId,
        quantityChange: -1,
        reason: "count error",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  test("throws NOT_FOUND for a product that doesn't exist", async () => {
    const error = await expectAppError(adjust(2_000_000_000, -1));

    expect(error.code).toBe("NOT_FOUND");
  });

  test("opens the branch's min_stock alert when stock drops below the minimum", async () => {
    const pId = await fixture.createProduct({ minStockBranch: 5 });
    await fixture.createBranchStock({
      pId,
      remain: 6,
      expiredDate: daysFromNow(30),
    });

    await adjust(pId, -2);

    const alerts = await db
      .select()
      .from(notification)
      .where(
        and(
          eq(notification.type, "min_stock"),
          eq(notification.pId, pId),
          eq(notification.branchId, fixture.branchId),
          eq(notification.isResolved, false),
        ),
      );
    expect(alerts).toHaveLength(1);

    // and nothing at HQ - branch stock moving doesn't touch HQ's alerts
    const hqAlerts = await db
      .select()
      .from(notification)
      .where(and(eq(notification.pId, pId), isNull(notification.branchId)));
    expect(hqAlerts).toHaveLength(0);
  });
});
