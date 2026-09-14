import {
  and,
  asc,
  count,
  eq,
  exists,
  ilike,
  inArray,
  or,
  not,
} from "drizzle-orm";
import { db } from "@/db/client";
import { product, productCategory, productCategoryMap } from "@/db/schema";
import type {
  CreateProductBody,
  ListProductsQuery,
  ListProductsResult,
  UpdateProductBody,
  Product,
  ProductCategoryRef,
  ProductRow,
} from "@/models/products.model";
import { AppError, postgresError, type ScopedActor } from "@/utils";

// Accepts either the top-level `db` or a transaction handed in by a caller.
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ============================================================================
// HELPER FUNCTIONS & VALIDATORS
// ============================================================================

async function requireProductById(id: number): Promise<ProductRow> {
  const [target] = await db.select().from(product).where(eq(product.pId, id));
  if (!target) throw new AppError("NOT_FOUND");
  return target;
}

// Barcode is already trimmed and validated non-empty by ProductsModel's
// createBody/updateBody schema before it reaches the service.
async function assertBarcodeAvailable(
  barcode: string,
  excludeId?: number,
): Promise<void> {
  const conditions = [
    eq(product.barcode, barcode),
    excludeId ? not(eq(product.pId, excludeId)) : undefined,
  ].filter((c) => c !== undefined);

  const [existing] = await db
    .select({ pId: product.pId })
    .from(product)
    .where(and(...conditions));

  if (existing) throw new AppError("ALREADY_EXISTS", { barcode });
}

// assertBarcodeAvailable's check-then-insert has a TOCTOU gap under concurrent
// requests; the DB's unique constraint on product.barcode is the actual
// backstop. This turns that race's raw 23505 into the same ALREADY_EXISTS
// shape the pre-check produces, instead of a bare 500.
function isDuplicateBarcodeError(error: unknown): boolean {
  const pgError = postgresError(error);
  return (
    pgError?.errno === "23505" &&
    pgError.constraint === "product_barcode_unique"
  );
}

/**
 * Every category of each product in `pIds`, sorted by name. Categories are
 * many-per-product, so joining them into a listing query would multiply its
 * rows and break limit/offset — callers fetch the page first, then this.
 * Products with no categories are simply missing from the map.
 */
export async function categoriesFor(
  pIds: number[],
  dbOrTx: DbOrTx = db,
): Promise<Map<number, ProductCategoryRef[]>> {
  const categoriesByProduct = new Map<number, ProductCategoryRef[]>();
  if (pIds.length === 0) return categoriesByProduct;

  const rows = await dbOrTx
    .select({
      pId: productCategoryMap.pId,
      categoryId: productCategory.categoryId,
      categoryName: productCategory.categoryName,
    })
    .from(productCategoryMap)
    .innerJoin(
      productCategory,
      eq(productCategory.categoryId, productCategoryMap.categoryId),
    )
    // ids may repeat (e.g. one inventory row per lot), hence the dedupe
    .where(inArray(productCategoryMap.pId, [...new Set(pIds)]))
    .orderBy(productCategory.categoryName);

  for (const { pId, categoryId, categoryName } of rows) {
    const categories = categoriesByProduct.get(pId) ?? [];
    categories.push({ categoryId, categoryName });
    categoriesByProduct.set(pId, categories);
  }
  return categoriesByProduct;
}

async function withCategories(
  rows: ProductRow[],
  dbOrTx: DbOrTx = db,
): Promise<Product[]> {
  const categoriesByProduct = await categoriesFor(
    rows.map((row) => row.pId),
    dbOrTx,
  );
  return rows.map((row) => ({
    ...row,
    categories: categoriesByProduct.get(row.pId) ?? [],
  }));
}

/**
 * Replaces a product's category links with exactly `categoryIds` (duplicates
 * ignored, [] clears them). Unknown ids are a 400 rather than letting the
 * FK surface as a 500. The ids are read `FOR SHARE`, so a concurrent
 * DELETE /categories/:id waits for this transaction and then fails with
 * CATEGORY_IN_USE, instead of deleting a category between this check and
 * the insert.
 */
async function setCategories(
  tx: DbOrTx,
  pId: number,
  categoryIds: number[],
): Promise<void> {
  const ids = [...new Set(categoryIds)];

  if (ids.length > 0) {
    const found = new Set(
      (
        await tx
          .select({ categoryId: productCategory.categoryId })
          .from(productCategory)
          .where(inArray(productCategory.categoryId, ids))
          .for("share")
      ).map(({ categoryId }) => categoryId),
    );
    const unknown = ids.filter((id) => !found.has(id));
    if (unknown.length > 0) {
      throw new AppError("BAD_REQUEST", {
        reason: "Unknown category ids",
        categoryIds: unknown,
      });
    }
  }

  await tx.delete(productCategoryMap).where(eq(productCategoryMap.pId, pId));
  if (ids.length > 0) {
    await tx
      .insert(productCategoryMap)
      .values(ids.map((categoryId) => ({ pId, categoryId })));
  }
}

// ============================================================================
// SERVICE EXPORT
// ============================================================================

export const productsService = {
  async list(
    actor: ScopedActor,
    query: ListProductsQuery,
  ): Promise<ListProductsResult> {
    const limit = Math.max(1, query.limit ?? 20);
    const offset = Math.max(0, query.offset ?? 0);

    const conditions = [
      query.isActive !== undefined
        ? eq(product.isActive, query.isActive)
        : undefined,
      query.search?.trim()
        ? or(
            ilike(product.name, `%${query.search.trim()}%`),
            ilike(product.barcode, `%${query.search.trim()}%`),
          )
        : undefined,
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
    ].filter((condition) => condition !== undefined);

    const where = conditions.length ? and(...conditions) : undefined;

    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(product)
        .where(where)
        .orderBy(asc(product.pId))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(product).where(where),
    ]);

    return {
      products: await withCategories(rows),
      total,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      totalPages: Math.ceil(total / limit),
    };
  },

  async getById(actor: ScopedActor, id: number): Promise<Product> {
    const [found] = await withCategories([await requireProductById(id)]);
    return found;
  },

  async create(actor: ScopedActor, body: CreateProductBody): Promise<Product> {
    if (actor.userType !== "hq") {
      throw new AppError("FORBIDDEN", {
        reason: "Only HQ can create products",
      });
    }

    await assertBarcodeAvailable(body.barcode);

    const { categoryIds, ...productData } = body;
    return await db.transaction(async (tx) => {
      try {
        const [newProduct] = await tx
          .insert(product)
          .values(productData)
          .returning();

        // An unknown category id throws here, rolling the product back too.
        await setCategories(tx, newProduct.pId, categoryIds ?? []);

        const [created] = await withCategories([newProduct], tx);
        return created;
      } catch (error) {
        if (isDuplicateBarcodeError(error)) {
          throw new AppError("ALREADY_EXISTS", { barcode: body.barcode });
        }
        throw error;
      }
    });
  },

  async update(
    actor: ScopedActor,
    id: number,
    body: UpdateProductBody,
  ): Promise<Product> {
    if (actor.userType !== "hq") {
      throw new AppError("FORBIDDEN", {
        reason: "Only HQ can update products",
      });
    }

    const target = await requireProductById(id);

    const { categoryIds, ...updateData } = body;

    if (updateData.barcode && updateData.barcode !== target.barcode) {
      await assertBarcodeAvailable(updateData.barcode, id);
    }

    // Changing only the categories is still a change to the product, so it
    // bumps updatedAt too. With nothing to change at all (an empty body) the
    // update is skipped — drizzle rejects an empty .set().
    const changes =
      categoryIds === undefined
        ? updateData
        : { ...updateData, updatedAt: new Date() };

    try {
      return await db.transaction(async (tx) => {
        let updated = target;
        if (Object.keys(changes).length > 0) {
          [updated] = await tx
            .update(product)
            .set(changes)
            .where(eq(product.pId, id))
            .returning();
        }

        // undefined = leave the categories alone; [] = remove them all
        if (categoryIds !== undefined) {
          await setCategories(tx, id, categoryIds);
        }

        const [result] = await withCategories([updated], tx);
        return result;
      });
    } catch (error) {
      if (isDuplicateBarcodeError(error)) {
        throw new AppError("ALREADY_EXISTS", { barcode: updateData.barcode });
      }
      throw error;
    }
  },

  async deactivate(actor: ScopedActor, id: number): Promise<Product> {
    if (actor.userType !== "hq") {
      throw new AppError("FORBIDDEN", {
        reason: "Only HQ can deactivate products",
      });
    }

    const target = await requireProductById(id);

    if (!target.isActive) {
      throw new AppError("BAD_REQUEST", {
        reason: "Product is already deactivated",
      });
    }

    const [updated] = await db
      .update(product)
      .set({ isActive: false })
      .where(eq(product.pId, id))
      .returning();

    const [result] = await withCategories([updated]);
    return result;
  },
};
