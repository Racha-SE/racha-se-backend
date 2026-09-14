import { SQL } from "bun";
import { and, count, eq, ilike, or, not } from "drizzle-orm";
import { db } from "@/db/client";
import { product } from "@/db/schema";
// import { productCategoryMap } from "@/db/schema"; // Uncomment when ready
import type {
  CreateProductBody,
  ListProductsQuery,
  ListProductsResult,
  UpdateProductBody,
  Product,
} from "@/models/products.model";
import { AppError, type ScopedActor } from "@/utils";

// ============================================================================
// HELPER FUNCTIONS & VALIDATORS
// ============================================================================

async function requireProductById(id: number): Promise<Product> {
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
//
// drizzle-orm's bun-sql adapter always wraps driver errors in its own
// DrizzleQueryError, with the real SQL.PostgresError as `.cause` — check
// that instead of `error` itself. And on SQL.PostgresError, the Postgres
// SQLSTATE ("23505") is `.errno`; `.code` is Bun's own wrapper code
// ("ERR_POSTGRES_SERVER_ERROR"), not the SQLSTATE.
function isDuplicateBarcodeError(error: unknown): boolean {
  const cause = error instanceof Error && error.cause ? error.cause : error;
  return (
    cause instanceof SQL.PostgresError &&
    cause.errno === "23505" &&
    cause.constraint === "product_barcode_unique"
  );
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
    ].filter((condition) => condition !== undefined);

    const where = conditions.length ? and(...conditions) : undefined;

    const [products, [{ total }]] = await Promise.all([
      db.select().from(product).where(where).limit(limit).offset(offset),
      db.select({ total: count() }).from(product).where(where),
    ]);

    return {
      products,
      total,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      totalPages: Math.ceil(total / limit),
    };
  },

  async getById(actor: ScopedActor, id: number): Promise<Product> {
    return await requireProductById(id);
  },

  async create(actor: ScopedActor, body: CreateProductBody): Promise<Product> {
    if (actor.userType !== "hq") {
      throw new AppError("FORBIDDEN", {
        reason: "Only HQ can create products",
      });
    }

    await assertBarcodeAvailable(body.barcode);

    const { categoryIds: _categoryIds, ...productData } = body;
    return await db.transaction(async (tx) => {
      try {
        const [newProduct] = await tx
          .insert(product)
          .values(productData)
          .returning();

        // if (categoryIds && categoryIds.length > 0) {
        //   await tx.insert(productCategoryMap).values(
        //     categoryIds.map((cId) => ({ pId: newProduct.pId, categoryId: cId }))
        //   );
        // }

        return newProduct;
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

    const { categoryIds: _categoryIds, ...updateData } = body;

    if (updateData.barcode && updateData.barcode !== target.barcode) {
      await assertBarcodeAvailable(updateData.barcode, id);
    }

    try {
      const [updated] = await db
        .update(product)
        .set(updateData)
        .where(eq(product.pId, id))
        .returning();

      return updated;
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

    return updated;
  },
};
