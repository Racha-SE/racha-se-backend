import { AppError } from "@/utils";
import {
  and,
  asc,
  count,
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
  HqInventoryGroupByProduct,
  HqInventoryQuery,
  HqInventoryResult,
} from "@/models/inventory.model";
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

/**
 * Categories are many-per-product: joining them into the listing query would
 * multiply its rows and break limit/offset, so they're fetched for the page
 * that query returned. Ids may repeat (one row per lot), hence the dedupe.
 */
async function categoriesFor(pIds: number[]): Promise<Map<number, string[]>> {
  const rows = await db
    .select({
      pId: productCategoryMap.pId,
      categoryName: productCategory.categoryName,
    })
    .from(productCategoryMap)
    .innerJoin(
      productCategory,
      eq(productCategory.categoryId, productCategoryMap.categoryId),
    )
    .where(inArray(productCategoryMap.pId, [...new Set(pIds)]))
    .orderBy(productCategory.categoryName);

  const categoriesByProduct = new Map<number, string[]>();
  for (const { pId, categoryName } of rows) {
    const categories = categoriesByProduct.get(pId) ?? [];
    categories.push(categoryName);
    categoriesByProduct.set(pId, categories);
  }
  return categoriesByProduct;
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
    const isGrouped = query.groupBy ?? false;

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

    const direction = query.sortOrder === "desc" ? desc : asc;
    // Either way the sort option is a fact about a lot, so both shapes sort on
    // the same columns: ungrouped orders the rows themselves, grouped orders
    // the lots inside each product.
    const lotSortColumns = {
      quantity: headOrderDetail.remain,
      price: headOrderDetail.basePrice,
      expiredDate: headOrderDetail.expiredDate,
    };
    const sortBy = query.sortOption
      ? lotSortColumns[query.sortOption]
      : undefined;

    if (!isGrouped) {
      // Ungrouped is a list of lots, not of products: every on-hand
      // head_order_detail row stands on its own, so a product shows up once per
      // lot it still has, and limit/offset page over lots.
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
            quantity: headOrderDetail.remain,
            price: headOrderDetail.basePrice,
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

      const categoriesByProduct = await categoriesFor(
        rows.map((row) => row.pId),
      );

      return {
        inventory: rows.map((row) => ({
          pId: row.pId,
          productName: row.productName,
          description: row.description ?? "",
          barcode: row.barcode,
          productCategory: categoriesByProduct.get(row.pId) ?? [],
          quantity: row.quantity,
          price: row.price,
          expiredDate: row.expiredDate.toISOString(),
        })),
        totalCount,
      };
    }

    // Grouped mode pages over *products*, so the page is a product list: the
    // lots only decide whether a product has stock at all (`exists`), never how
    // many rows it takes up. Joining them in here would multiply the rows and
    // turn `limit` into a count of lots.
    const productWhere = and(
      ...conditions,
      exists(
        db
          .select({ pId: headOrderDetail.pId })
          .from(headOrderDetail)
          .innerJoin(order, eq(order.lotId, headOrderDetail.lotId))
          .where(and(onHandLots(), eq(headOrderDetail.pId, product.pId))),
      ),
    );

    // Counting `product` rows rather than lots, to match what this mode pages
    // over — a product with five lots on hand is one row here, same as in the
    // page itself.
    const [rows, [{ totalCount }]] = await Promise.all([
      db
        .select({
          pId: product.pId,
          productName: product.name,
          description: product.description,
          barcode: product.barcode,
        })
        .from(product)
        .where(productWhere)
        .orderBy(asc(product.pId))
        .limit(limit)
        .offset(offset),
      db.select({ totalCount: count() }).from(product).where(productWhere),
    ]);

    if (rows.length === 0) return { inventory: [], totalCount };

    const pIds = rows.map((row) => row.pId);
    const categoriesByProduct = await categoriesFor(pIds);

    // The lots of this page of products. The sort option orders them *within*
    // each product (pId leads the ordering, so the rows arrive grouped);
    // without one they're FEFO, which is the order they'll go out in.
    const lotRows = await db
      .select({
        pId: headOrderDetail.pId,
        quantity: headOrderDetail.remain,
        price: headOrderDetail.basePrice,
        expiredDate: headOrderDetail.expiredDate,
      })
      .from(headOrderDetail)
      .innerJoin(order, eq(order.lotId, headOrderDetail.lotId))
      .where(and(onHandLots(), inArray(headOrderDetail.pId, pIds)))
      .orderBy(
        asc(headOrderDetail.pId),
        sortBy ? direction(sortBy) : asc(headOrderDetail.expiredDate),
        asc(headOrderDetail.hodId),
      );

    const stocksByProduct = new Map<
      number,
      HqInventoryGroupByProduct["stocks"]
    >();
    for (const lot of lotRows) {
      const stocks = stocksByProduct.get(lot.pId) ?? [];
      stocks.push({
        quantity: lot.quantity,
        price: lot.price,
        expiredDate: lot.expiredDate.toISOString(),
      });
      stocksByProduct.set(lot.pId, stocks);
    }

    return {
      inventory: rows.map((row) => ({
        pId: row.pId,
        productName: row.productName,
        description: row.description ?? "",
        barcode: row.barcode,
        productCategory: categoriesByProduct.get(row.pId) ?? [],
        stocks: stocksByProduct.get(row.pId) ?? [],
      })),
      totalCount,
    };
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
