import { AppError } from "@/utils";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  or,
  sql,
  sum,
  lte,
  isNotNull,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db/client";
import {
  headOrderDetail,
  branchOrderDetail,
  branch,
  order,
  product,
  productCategory,
  productCategoryMap,
} from "@/db/schema";
import type {
  HqInventoryItem,
  HqInventoryQuery,
} from "@/models/inventory.model";
import { assertBranchScope, type ScopedActor } from "@/utils";

const DEFAULT_LIMIT = 20;

/**
 * What counts as HQ stock on hand: a head_order_detail lot whose order is an
 * approved hq order, that still has something left (`remain > 0`) and hasn't
 * expired. Same rule ordersBranchService.create picks lots with — the two must
 * agree, otherwise HQ shows stock a branch can't actually order.
 */
function onHandLots(now: Date): SQL | undefined {
  return and(
    eq(order.orderType, "hq"),
    eq(order.status, "approved"),
    gt(headOrderDetail.remain, 0),
    gt(headOrderDetail.expiredDate, now),
  );
}

/** Alphabetically-first category of a product — only used as a sort key. */
const firstCategoryName = sql<string>`(
  select min(${productCategory.categoryName})
  from ${productCategoryMap}
  join ${productCategory}
    on ${productCategory.categoryId} = ${productCategoryMap.categoryId}
  where ${productCategoryMap.pId} = ${product.pId}
)`;

export const inventoryService = {
  async getHqStock(
    actor: ScopedActor,
    query: HqInventoryQuery,
  ): Promise<HqInventoryItem[]> {
    // HQ stock isn't owned by any branch, so only an hq actor is in scope.
    assertBranchScope(actor, null);

    const now = new Date();
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;

    // Stock is tracked per lot; the API reports per product, so sum the lots.
    const stock = db
      .select({
        pId: headOrderDetail.pId,
        quantity: sql<number>`sum(${headOrderDetail.remain})::int`.as(
          "quantity",
        ),
      })
      .from(headOrderDetail)
      .innerJoin(order, eq(order.lotId, headOrderDetail.lotId))
      .where(onHandLots(now))
      .groupBy(headOrderDetail.pId)
      .as("stock");

    // Lots go out FEFO, so the earliest-expiring one is what ships next — its
    // expiry and base price are the ones worth showing for the product.
    const nextLot = db
      .selectDistinctOn([headOrderDetail.pId], {
        pId: headOrderDetail.pId,
        expiredDate: headOrderDetail.expiredDate,
        price: headOrderDetail.basePrice,
      })
      .from(headOrderDetail)
      .innerJoin(order, eq(order.lotId, headOrderDetail.lotId))
      .where(onHandLots(now))
      .orderBy(headOrderDetail.pId, asc(headOrderDetail.expiredDate))
      .as("next_lot");

    const conditions = [
      eq(product.isActive, true),
      query.search
        ? or(
            ilike(product.name, `%${query.search}%`),
            ilike(product.barcode, `%${query.search}%`),
          )
        : undefined,
      query.categoryName
        ? exists(
            db
              .select({ pId: productCategoryMap.pId })
              .from(productCategoryMap)
              .innerJoin(
                productCategory,
                eq(productCategory.categoryId, productCategoryMap.categoryId),
              )
              .where(
                and(
                  eq(productCategoryMap.pId, product.pId),
                  ilike(productCategory.categoryName, query.categoryName),
                ),
              ),
          )
        : undefined,
    ].filter((condition) => condition !== undefined);

    const sortColumns = {
      pId: product.pId,
      name: product.name,
      categoryName: firstCategoryName,
      quantity: stock.quantity,
      price: nextLot.price,
      expiredDate: nextLot.expiredDate,
    };
    const sortBy = sortColumns[query.sortOption ?? "pId"];
    const direction = query.sortOrder === "desc" ? desc : asc;

    const rows = await db
      .select({
        pId: product.pId,
        productName: product.name,
        description: product.description,
        barcode: product.barcode,
        quantity: stock.quantity,
        price: nextLot.price,
        expiredDate: nextLot.expiredDate,
      })
      .from(product)
      // inner join: a product with no on-hand lot isn't stock, so it's left out
      // entirely rather than listed with quantity 0 and no expiry.
      .innerJoin(stock, eq(stock.pId, product.pId))
      .innerJoin(nextLot, eq(nextLot.pId, product.pId))
      .where(and(...conditions))
      // pId breaks ties so paging through a non-unique sort key is stable.
      .orderBy(direction(sortBy), asc(product.pId))
      .limit(limit)
      .offset(offset);

    if (rows.length === 0) return [];

    // Categories are many-per-product: joining them into the query above would
    // multiply its rows and break limit/offset, so fetch them for this page.
    const categoryRows = await db
      .select({
        pId: productCategoryMap.pId,
        categoryName: productCategory.categoryName,
      })
      .from(productCategoryMap)
      .innerJoin(
        productCategory,
        eq(productCategory.categoryId, productCategoryMap.categoryId),
      )
      .where(
        inArray(
          productCategoryMap.pId,
          rows.map((row) => row.pId),
        ),
      )
      .orderBy(productCategory.categoryName);

    const categoriesByProduct = new Map<number, string[]>();
    for (const { pId, categoryName } of categoryRows) {
      const categories = categoriesByProduct.get(pId) ?? [];
      categories.push(categoryName);
      categoriesByProduct.set(pId, categories);
    }

    return rows.map((row) => ({
      pId: String(row.pId),
      productName: row.productName,
      description: row.description ?? "",
      barcode: row.barcode,
      productCategory: categoriesByProduct.get(row.pId) ?? [],
      quantity: row.quantity,
      price: row.price,
      expiredDate: row.expiredDate.toISOString(),
    }));
  },

  async listHqNearExpiry() {
    const daysToExpiry = 7;
    // ดึงข้อมูลจาก head_order_detail แทน เพราะฝั่ง HQ เก็บสต็อกเป็นล็อตไว้ที่นี่
    const nearExpiryItems = await db
      .select({
        lotId: headOrderDetail.lotId,
        quantity: headOrderDetail.remain,
        expiredDate: headOrderDetail.expiredDate,
        product: {
          pId: product.pId,
          name: product.name,
          barcode: product.barcode,
        },
      })
      .from(headOrderDetail)
      .innerJoin(product, eq(headOrderDetail.pId, product.pId))
      .where(
        and(
          sql`${headOrderDetail.remain} > 0`,
          isNotNull(headOrderDetail.expiredDate),
          lte(
            headOrderDetail.expiredDate,
            sql`NOW() + INTERVAL '${sql.raw(`${daysToExpiry} days`)}'`,
          ),
        ),
      );

    return nearExpiryItems;
  },

  // --- Branch Scope---
  async getBranchStock(branchId: number) {
    const [foundBranch] = await db
      .select()
      .from(branch)
      .where(eq(branch.branchId, branchId));

    if (!foundBranch) {
      throw new AppError("NOT_FOUND");
    }
    if (foundBranch.isActive === false) {
      throw new AppError("FORBIDDEN");
    }

    const items = await db
      .select({
        branchId: branchOrderDetail.branchId,
        quantity: sum(branchOrderDetail.remain).mapWith(Number),
        product: {
          pId: product.pId,
          name: product.name,
          barcode: product.barcode,
        },
      })
      .from(branchOrderDetail)
      .innerJoin(product, eq(branchOrderDetail.pId, product.pId))
      .where(eq(branchOrderDetail.branchId, branchId))
      .groupBy(
        branchOrderDetail.branchId,
        product.pId,
        product.name,
        product.barcode,
      );

    return items;
  },

  async listBranchLowStock(branchId: number) {
    const items = await this.getBranchStock(branchId);
    return items.filter((item) => item.quantity <= 5);
  },

  async listBranchNearExpiry(branchId: number) {
    const [foundBranch] = await db
      .select()
      .from(branch)
      .where(eq(branch.branchId, branchId));

    if (!foundBranch) {
      throw new AppError("NOT_FOUND");
    }
    if (foundBranch.isActive === false) {
      throw new AppError("FORBIDDEN");
    }

    const daysToExpiry = 7;

    const nearExpiryItems = await db
      .select({
        branchId: branchOrderDetail.branchId,
        lotId: branchOrderDetail.lotId,
        quantity: branchOrderDetail.remain,
        expiredDate: branchOrderDetail.expiredDate,
        product: {
          pId: product.pId,
          name: product.name,
          barcode: product.barcode,
        },
      })
      .from(branchOrderDetail)
      .innerJoin(product, eq(branchOrderDetail.pId, product.pId))
      .where(
        and(
          eq(branchOrderDetail.branchId, branchId),
          sql`${branchOrderDetail.remain} > 0`,
          isNotNull(branchOrderDetail.expiredDate),
          lte(
            branchOrderDetail.expiredDate,
            sql`NOW() + INTERVAL '${sql.raw(`${daysToExpiry} days`)}'`,
          ),
        ),
      );

    return nearExpiryItems;
  },
};
