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

function validateProductFields(
  data: Partial<CreateProductBody | UpdateProductBody>,
): void {
  // 1. Numeric boundary validation
  if (data.costPrice !== undefined && data.costPrice < 0) {
    throw new AppError("BAD_REQUEST", {
      reason: "costPrice cannot be negative",
    });
  }
  if (data.minStockHq !== undefined && data.minStockHq < 0) {
    throw new AppError("BAD_REQUEST", {
      reason: "minStockHq cannot be negative",
    });
  }
  if (data.minStockBranch !== undefined && data.minStockBranch < 0) {
    throw new AppError("BAD_REQUEST", {
      reason: "minStockBranch cannot be negative",
    });
  }

  // 2. String empty/whitespace validation
  if (data.name !== undefined && data.name.trim().length === 0) {
    throw new AppError("BAD_REQUEST", {
      reason: "Product name cannot be empty or whitespace",
    });
  }
  if (data.barcode !== undefined && data.barcode.trim().length === 0) {
    throw new AppError("BAD_REQUEST", {
      reason: "Barcode cannot be empty or whitespace",
    });
  }
}

async function assertBarcodeAvailable(
  barcode: string,
  excludeId?: number,
): Promise<void> {
  const cleanBarcode = barcode.trim();

  if (!cleanBarcode) {
    throw new AppError("BAD_REQUEST", { reason: "Barcode cannot be empty" });
  }

  const conditions = [
    eq(product.barcode, cleanBarcode),
    excludeId ? not(eq(product.pId, excludeId)) : undefined,
  ].filter((c) => c !== undefined);

  const [existing] = await db
    .select({ pId: product.pId })
    .from(product)
    .where(and(...conditions));

  if (existing) throw new AppError("ALREADY_EXISTS", { barcode: cleanBarcode });
}

// assertBarcodeAvailable's check-then-insert has a TOCTOU gap under concurrent
// requests; the DB's unique constraint on product.barcode is the actual
// backstop. This turns that race's raw 23505 into the same ALREADY_EXISTS
// shape the pre-check produces, instead of a bare 500.
function isDuplicateBarcodeError(error: unknown): boolean {
  return (
    error instanceof SQL.PostgresError &&
    error.code === "23505" &&
    error.constraint === "product_barcode_unique"
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
    if (!id || id <= 0) {
      throw new AppError("BAD_REQUEST", { reason: "Invalid product ID" });
    }
    return await requireProductById(id);
  },

  async create(actor: ScopedActor, body: CreateProductBody): Promise<Product> {
    if (actor.userType !== "hq") {
      throw new AppError("FORBIDDEN", {
        reason: "Only HQ can create products",
      });
    }

    // Run input validation
    validateProductFields(body);

    const cleanBarcode = body.barcode.trim();
    const cleanName = body.name.trim();

    await assertBarcodeAvailable(cleanBarcode);

    const { categoryIds: _categoryIds, ...productData } = body;
    return await db.transaction(async (tx) => {
      try {
        const [newProduct] = await tx
          .insert(product)
          .values({
            ...productData,
            name: cleanName,
            barcode: cleanBarcode,
            description: productData.description?.trim(),
          })
          .returning();

        // if (categoryIds && categoryIds.length > 0) {
        //   await tx.insert(productCategoryMap).values(
        //     categoryIds.map((cId) => ({ pId: newProduct.pId, categoryId: cId }))
        //   );
        // }

        return newProduct;
      } catch (error) {
        if (isDuplicateBarcodeError(error)) {
          throw new AppError("ALREADY_EXISTS", { barcode: cleanBarcode });
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

    if (!id || id <= 0) {
      throw new AppError("BAD_REQUEST", { reason: "Invalid product ID" });
    }

    const target = await requireProductById(id);

    // Validate update fields if present
    validateProductFields(body);

    const { categoryIds: _categoryIds, ...updateData } = body;
    // Sanitize string fields
    if (updateData.name) updateData.name = updateData.name.trim();
    if (updateData.barcode) updateData.barcode = updateData.barcode.trim();
    if (updateData.description)
      updateData.description = updateData.description.trim();

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

    if (!id || id <= 0) {
      throw new AppError("BAD_REQUEST", { reason: "Invalid product ID" });
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
