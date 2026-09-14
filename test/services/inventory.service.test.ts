import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { productCategory, productCategoryMap } from "@/db/schema";
import type {
  HqInventoryGroupByProduct,
  HqInventoryItem,
} from "@/models/inventory.model";
import type { ProductCategoryRef } from "@/models/products.model";
import { inventoryService } from "@/services/inventory.service";
import type { ScopedActor } from "@/utils";
import {
  type OrdersHqFixture,
  setupOrdersHqFixture,
} from "../helpers/orders-hq";

let fixture: OrdersHqFixture;
let hqActor: ScopedActor;
const createdCategoryIds: number[] = [];
const createdProductIds: number[] = [];
// Prefixed so they sort the same under any collation: "aaa" before "zzz".
let firstCategory: ProductCategoryRef;
let secondCategory: ProductCategoryRef;
/** in both categories */
let bothPId: number;
/** in secondCategory only */
let secondOnlyPId: number;

async function createCategory(prefix: string): Promise<ProductCategoryRef> {
  const [created] = await db
    .insert(productCategory)
    .values({ categoryName: `${prefix} Inventory Test ${crypto.randomUUID()}` })
    .returning({
      categoryId: productCategory.categoryId,
      categoryName: productCategory.categoryName,
    });
  createdCategoryIds.push(created.categoryId);

  return created;
}

/** A product with one lot of HQ stock on hand, linked to `categories`. */
async function createStockedProduct(categories: ProductCategoryRef[]) {
  const pId = await fixture.createProduct();
  createdProductIds.push(pId);
  await fixture.createHqStock({ pId, remain: 10 });
  await db
    .insert(productCategoryMap)
    .values(categories.map(({ categoryId }) => ({ pId, categoryId })));

  return pId;
}

beforeAll(async () => {
  fixture = await setupOrdersHqFixture("svcinventory");
  hqActor = { id: fixture.hqUser.id, userType: "hq", branchId: null };

  firstCategory = await createCategory("aaa");
  secondCategory = await createCategory("zzz");
  bothPId = await createStockedProduct([secondCategory, firstCategory]);
  secondOnlyPId = await createStockedProduct([secondCategory]);
});

afterAll(async () => {
  // category links reference both the products and the categories, and the
  // fixture's cleanup deletes the products — so the links have to go first
  await db
    .delete(productCategoryMap)
    .where(inArray(productCategoryMap.pId, createdProductIds));
  await fixture.cleanup();
  await db
    .delete(productCategory)
    .where(inArray(productCategory.categoryId, createdCategoryIds));
});

describe("inventoryService.getHqStock — categories", () => {
  test("ungrouped rows carry category ids and names, sorted by name", async () => {
    const result = await inventoryService.getHqStock(hqActor, {
      categoryId: secondCategory.categoryId,
      limit: 100,
    });
    const row = (result.inventory as HqInventoryItem[]).find(
      (item) => item.pId === bothPId,
    );

    expect(row?.categories).toEqual([firstCategory, secondCategory]);
    // the older names-only field is still there, in the same order
    expect(row?.productCategory).toEqual([
      firstCategory.categoryName,
      secondCategory.categoryName,
    ]);
  });

  test("grouped rows carry the same category fields", async () => {
    const result = await inventoryService.getHqStock(hqActor, {
      categoryId: secondCategory.categoryId,
      groupBy: true,
      limit: 100,
    });
    const row = (result.inventory as HqInventoryGroupByProduct[]).find(
      (item) => item.pId === secondOnlyPId,
    );

    expect(row?.categories).toEqual([secondCategory]);
    expect(row?.productCategory).toEqual([secondCategory.categoryName]);
  });

  test("categoryId filters to products linked to that category", async () => {
    const result = await inventoryService.getHqStock(hqActor, {
      categoryId: firstCategory.categoryId,
      groupBy: true,
      limit: 100,
    });
    const pIds = result.inventory.map((item) => item.pId);

    expect(pIds).toEqual([bothPId]);
    expect(result.totalCount).toBe(1);
  });
});
