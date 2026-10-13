import { AppError } from "@/utils";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gt,
  ilike,
  or,
  sum,
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
  BranchInventoryQuery,
  BranchInventoryResult,
  HqInventoryQuery,
  HqInventoryResult,
} from "@/models/inventory.model";
import type { ProductCategoryRef } from "@/models/products.model";
import { categoriesFor } from "@/services/products.service";
import { assertBranchScope, type ScopedActor } from "@/utils";

const DEFAULT_LIMIT = 20;

/**
 * What counts as HQ stock on hand: a head_order_detail lot whose order is an
 * approved hq order and still has something left (`remain > 0`). Expired lots
 * stay in the count — they're physically still on the shelf, and
 * `listHqNearExpiry` is what flags them.
 */
function onHandLots(): SQL | undefined {
  return and(
    eq(order.orderType, "hq"),
    eq(order.status, "approved"),
    gt(headOrderDetail.remain, 0),
  );
}

/** Both category fields of an inventory item, from one product's categories. */
function categoryFields(categories: ProductCategoryRef[] = []) {
  return {
    productCategory: categories.map(({ categoryName }) => categoryName),
    categories,
  };
}

/** 404s on a missing branch, 403s on a deactivated one — shared by every branch-scoped read. */
async function assertActiveBranch(branchId: number): Promise<void> {
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
}

/** Name/barcode search, shared by the HQ and branch stock listings. */
function productSearchFilter(search?: string): SQL | undefined {
  return search
    ? or(
        ilike(product.name, `%${search}%`),
        ilike(product.barcode, `%${search}%`),
      )
    : undefined;
}

/** categoryId/categoryName filters, shared by the HQ and branch stock listings. */
function categoryFilters(query: {
  categoryId?: number;
  categoryName?: string;
}): (SQL | undefined)[] {
  return [
    query.categoryId !== undefined
      ? exists(
          db
            .select({ pId: productCategoryMap.pId })
            .from(productCategoryMap)
            .where(
              and(
                eq(productCategoryMap.pId, product.pId),
                eq(productCategoryMap.categoryId, query.categoryId),
              ),
            ),
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
  ];
}

export const inventoryService = {
  async getHqStock(
    actor: ScopedActor,
    query: HqInventoryQuery,
  ): Promise<HqInventoryResult> {
    // HQ stock isn't owned by any branch, so only an hq actor is in scope.
    assertBranchScope(actor, null);

    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;

    const conditions = [
      eq(product.isActive, true),
      productSearchFilter(query.search),
      ...categoryFilters(query),
    ].filter((condition) => condition !== undefined);

    const direction = query.sortOrder === "desc" ? desc : asc;
    const lotSortColumns = {
      quantity: headOrderDetail.remain,
      costPrice: headOrderDetail.costPrice,
      expiredDate: headOrderDetail.expiredDate,
    };
    const sortBy = query.sortOption
      ? lotSortColumns[query.sortOption]
      : undefined;

    // One row per on-hand head_order_detail lot: a product with several lots
    // shows up once per lot, and limit/offset page over lots, not products.
    const lotWhere = and(onHandLots(), ...conditions);

    // The count runs the same filters without limit/offset, so it's the size
    // of the whole result set — the page's own length is `inventory.length`.
    const [rows, [{ totalCount }]] = await Promise.all([
      db
        .select({
          pId: product.pId,
          productName: product.name,
          description: product.description,
          barcode: product.barcode,
          price: product.price,
          quantity: headOrderDetail.remain,
          costPrice: headOrderDetail.costPrice,
          expiredDate: headOrderDetail.expiredDate,
        })
        .from(headOrderDetail)
        .innerJoin(order, eq(order.lotId, headOrderDetail.lotId))
        .innerJoin(product, eq(product.pId, headOrderDetail.pId))
        .where(lotWhere)
        // Sort option first, then a product's own lots FEFO, with hodId as
        // the unique tiebreak that keeps paging over a non-unique key stable.
        .orderBy(
          ...(sortBy ? [direction(sortBy)] : []),
          asc(headOrderDetail.pId),
          asc(headOrderDetail.expiredDate),
          asc(headOrderDetail.hodId),
        )
        .limit(limit)
        .offset(offset),
      db
        .select({ totalCount: count() })
        .from(headOrderDetail)
        .innerJoin(order, eq(order.lotId, headOrderDetail.lotId))
        .innerJoin(product, eq(product.pId, headOrderDetail.pId))
        .where(lotWhere),
    ]);

    if (rows.length === 0) return { inventory: [], totalCount };

    const categoriesByProduct = await categoriesFor(rows.map((row) => row.pId));

    return {
      inventory: rows.map((row) => ({
        pId: row.pId,
        productName: row.productName,
        description: row.description ?? "",
        barcode: row.barcode,
        ...categoryFields(categoriesByProduct.get(row.pId)),
        quantity: row.quantity,
        price: row.price,
        costPrice: row.costPrice,
        expiredDate: row.expiredDate.toISOString(),
      })),
      totalCount,
    };
  },

  // --- Branch Scope---
  // Mirrors getHqStock (same search/category/sort/pagination, same ungrouped
  // vs grouped split), scoped to one branch instead of HQ-wide — the branch
  // catalog is meant to be the same UI as the HQ one. Ungrouped lists
  // branch_order_detail lots one row each, for a branch-manager-style
  // breakdown; grouped collapses them into a single on-hand total per
  // product, which is what a cashier needs to know whether they can sell it.
  async getBranchStock(
    branchId: number,
    query: BranchInventoryQuery = {},
  ): Promise<BranchInventoryResult> {
    await assertActiveBranch(branchId);

    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;
    const isGrouped = query.groupBy ?? false;

    const conditions = [
      eq(branchOrderDetail.branchId, branchId),
      productSearchFilter(query.search),
      ...categoryFilters(query),
    ].filter((condition) => condition !== undefined);

    const direction = query.sortOrder === "desc" ? desc : asc;
    const lotSortColumns = {
      quantity: branchOrderDetail.remain,
      costPrice: branchOrderDetail.costPrice,
      expiredDate: branchOrderDetail.expiredDate,
    };
    const sortBy = query.sortOption
      ? lotSortColumns[query.sortOption]
      : undefined;

    if (!isGrouped) {
      // Ungrouped is a list of lots, not of products: every on-hand
      // branch_order_detail row stands on its own, so a product shows up once
      // per lot it still has, and limit/offset page over lots.
      const lotWhere = and(gt(branchOrderDetail.remain, 0), ...conditions);

      const [rows, [{ totalCount }]] = await Promise.all([
        db
          .select({
            pId: product.pId,
            productName: product.name,
            description: product.description,
            barcode: product.barcode,
            price: product.price,
            quantity: branchOrderDetail.remain,
            costPrice: branchOrderDetail.costPrice,
            expiredDate: branchOrderDetail.expiredDate,
          })
          .from(branchOrderDetail)
          .innerJoin(product, eq(product.pId, branchOrderDetail.pId))
          .where(lotWhere)
          .orderBy(
            ...(sortBy ? [direction(sortBy)] : []),
            asc(branchOrderDetail.pId),
            asc(branchOrderDetail.expiredDate),
            asc(branchOrderDetail.bodId),
          )
          .limit(limit)
          .offset(offset),
        db
          .select({ totalCount: count() })
          .from(branchOrderDetail)
          .innerJoin(product, eq(product.pId, branchOrderDetail.pId))
          .where(lotWhere),
      ]);

      if (rows.length === 0) return { inventory: [], totalCount };

      const categoriesByProduct = await categoriesFor(
        rows.map((row) => row.pId),
      );

      return {
        inventory: rows.map((row) => ({
          pId: row.pId,
          productName: row.productName,
          description: row.description ?? "",
          barcode: row.barcode,
          ...categoryFields(categoriesByProduct.get(row.pId)),
          quantity: row.quantity,
          price: row.price,
          costPrice: row.costPrice,
          expiredDate: row.expiredDate?.toISOString() ?? null,
        })),
        totalCount,
      };
    }

    // Grouped mode pages over *products*: one row per product, every lot's
    // remain summed into a single total. Ordered by pId (not sortOption,
    // same as getHqStock's grouped mode) since there's no per-lot price or
    // expiry left to sort by once they're collapsed.
    const productWhere = and(...conditions);

    const [rows, [{ totalCount }]] = await Promise.all([
      db
        .select({
          pId: product.pId,
          productName: product.name,
          description: product.description,
          barcode: product.barcode,
          price: product.price,
          quantity: sum(branchOrderDetail.remain).mapWith(Number),
        })
        .from(branchOrderDetail)
        .innerJoin(product, eq(product.pId, branchOrderDetail.pId))
        .where(productWhere)
        .groupBy(
          product.pId,
          product.name,
          product.description,
          product.barcode,
          product.price,
        )
        .orderBy(asc(product.pId))
        .limit(limit)
        .offset(offset),
      db
        .select({ totalCount: countDistinct(product.pId) })
        .from(branchOrderDetail)
        .innerJoin(product, eq(product.pId, branchOrderDetail.pId))
        .where(productWhere),
    ]);

    if (rows.length === 0) return { inventory: [], totalCount };

    const categoriesByProduct = await categoriesFor(rows.map((row) => row.pId));

    return {
      inventory: rows.map((row) => ({
        pId: row.pId,
        productName: row.productName,
        description: row.description ?? "",
        barcode: row.barcode,
        ...categoryFields(categoriesByProduct.get(row.pId)),
        quantity: row.quantity,
        price: row.price,
      })),
      totalCount,
    };
  },
};
