import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ordersCustomerService } from "@/services/orders-customer.service";
import { reportsService } from "@/services/reports.service";
import {
  daysFromNow,
  setupOrdersCustomerFixture,
  type OrdersCustomerFixture,
} from "../helpers/orders-customer";

let fixture: OrdersCustomerFixture;

beforeAll(async () => {
  fixture = await setupOrdersCustomerFixture("svcreports");
});

afterAll(async () => {
  await fixture.cleanup();
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("reportsService.getSalesAndProfitReport", () => {
  test("prices a sale off the product's global price, and costs it off the lot it was actually drawn from", async () => {
    // product sells for 20 everywhere; this particular lot cost the branch 12
    const pId = await fixture.createProduct(20);
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(30),
      costPrice: 12,
    });

    const order = await ordersCustomerService.create(
      fixture.cashierUser.id,
      fixture.branchId,
      { paymentMethod: "cash", items: [{ pId, quantity: 3 }] },
    );

    const rows = await reportsService.getSalesAndProfitReport(today(), today());
    const row = rows.find((r) => r.orderId === order.lotId);

    expect(row).toMatchObject({
      quantity: 3,
      unitPrice: 20,
      unitCost: 12,
      totalSales: 60,
      totalProfit: 24,
    });
  });

  test("two sales of the same product from differently-costed lots report each one's own cost", async () => {
    const pId = await fixture.createProduct(15);
    // nearest-expiry first (FEFO), so the first sale below exhausts this lot
    // exactly and the second one is forced onto the other, pricier lot.
    await fixture.createBranchStock({
      pId,
      remain: 2,
      expiredDate: daysFromNow(10),
      costPrice: 5,
    });
    await fixture.createBranchStock({
      pId,
      remain: 10,
      expiredDate: daysFromNow(60),
      costPrice: 9,
    });

    const firstSale = await ordersCustomerService.create(
      fixture.cashierUser.id,
      fixture.branchId,
      { paymentMethod: "cash", items: [{ pId, quantity: 2 }] },
    );
    const secondSale = await ordersCustomerService.create(
      fixture.cashierUser.id,
      fixture.branchId,
      { paymentMethod: "cash", items: [{ pId, quantity: 4 }] },
    );

    const rows = await reportsService.getSalesAndProfitReport(today(), today());

    expect(rows.find((r) => r.orderId === firstSale.lotId)).toMatchObject({
      quantity: 2,
      unitPrice: 15,
      unitCost: 5,
      totalSales: 30,
      totalProfit: 20,
    });
    expect(rows.find((r) => r.orderId === secondSale.lotId)).toMatchObject({
      quantity: 4,
      unitPrice: 15,
      unitCost: 9,
      totalSales: 60,
      totalProfit: 24,
    });
  });
});
