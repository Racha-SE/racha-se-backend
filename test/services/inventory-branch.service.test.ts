import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { productCategory, productCategoryMap } from "@/db/schema";
import type {
  BranchInventoryGroupByProduct,
  BranchInventoryItem,
} from "@/models/inventory.model";
import type { ProductCategoryRef } from "@/models/products.model";
import { inventoryService } from "@/services/inventory.service";
import {
  daysFromNow,
  setupOrdersCustomerFixture,
  type OrdersCustomerFixture,
} from "../helpers/orders-customer";

let fixture: OrdersCustomerFixture;
const createdCategoryIds: number[] = [];
const createdProductIds: number[] = [];
let category: ProductCategoryRef;
/** two lots of the same product, different expiry/price */
let twoLotPId: number;
/** one lot, zero remain — shouldn't show up as on-hand */
let depletedPId: number;

beforeAll(async () => {
  fixture = await setupOrdersCustomerFixture("svcbranchinventory");

  const [created] = await db
    .insert(productCategory)
    .values({ categoryName: `Branch Inventory Test ${crypto.randomUUID()}` })
    .returning({
      categoryId: productCategory.categoryId,
      categoryName: productCategory.categoryName,
    });
  createdCategoryIds.push(created.categoryId);
  category = created;

  twoLotPId = await fixture.createProduct();
  createdProductIds.push(twoLotPId);
  await db
    .insert(productCategoryMap)
    .values({ pId: twoLotPId, categoryId: category.categoryId });
  await fixture.createBranchStock({
    pId: twoLotPId,
    remain: 4,
    expiredDate: daysFromNow(30),
    costPrice: 10,
  });
  await fixture.createBranchStock({
    pId: twoLotPId,
    remain: 6,
    expiredDate: daysFromNow(60),
    costPrice: 12,
  });

  depletedPId = await fixture.createProduct();
  createdProductIds.push(depletedPId);
  await fixture.createBranchStock({
    pId: depletedPId,
    remain: 0,
    expiredDate: daysFromNow(30),
  });
});

afterAll(async () => {
  await db
    .delete(productCategoryMap)
    .where(inArray(productCategoryMap.pId, createdProductIds));
  await fixture.cleanup();
  await db
    .delete(productCategory)
    .where(inArray(productCategory.categoryId, createdCategoryIds));
});

describe("inventoryService.getBranchStock", () => {
  test("ungrouped: one row per on-hand lot, carrying its own price/expiry", async () => {
    const result = await inventoryService.getBranchStock(fixture.branchId, {
      categoryId: category.categoryId,
      limit: 100,
    });
    const rows = (result.inventory as BranchInventoryItem[]).filter(
      (item) => item.pId === twoLotPId,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.quantity).sort()).toEqual([4, 6]);
    expect(rows[0].categories).toEqual([category]);
  });

  test("ungrouped: a depleted (remain = 0) lot is not on-hand", async () => {
    const result = await inventoryService.getBranchStock(fixture.branchId, {
      search: "Product",
      limit: 100,
    });
    const pIds = (result.inventory as BranchInventoryItem[]).map(
      (item) => item.pId,
    );

    expect(pIds).not.toContain(depletedPId);
  });

  test("grouped: every lot's remain summed into one row per product", async () => {
    const result = await inventoryService.getBranchStock(fixture.branchId, {
      categoryId: category.categoryId,
      groupBy: true,
      limit: 100,
    });
    const row = (result.inventory as BranchInventoryGroupByProduct[]).find(
      (item) => item.pId === twoLotPId,
    );

    expect(row?.quantity).toBe(10);
    expect(result.totalCount).toBe(1);
  });

  test("scoped to branchId: another branch's stock never shows up", async () => {
    const result = await inventoryService.getBranchStock(
      fixture.otherBranchId,
      { categoryId: category.categoryId, limit: 100 },
    );

    expect(result.inventory).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });
});
