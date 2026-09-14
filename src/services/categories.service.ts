import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { productCategory } from "@/db/schema";
import { AppError, postgresError } from "@/utils";
import type {
  CreateCategoryBody,
  UpdateCategoryBody,
} from "@/models/categories.model";

export const categoriesService = {
  async list() {
    return await db.select().from(productCategory);
  },

  async getById(id: number) {
    const [category] = await db
      .select()
      .from(productCategory)
      .where(eq(productCategory.categoryId, id));

    if (!category) {
      throw new AppError("NOT_FOUND");
    }
    return category;
  },

  async create(data: CreateCategoryBody) {
    const [existing] = await db //checking duplicate name
      .select()
      .from(productCategory)
      .where(eq(productCategory.categoryName, data.categoryName));

    if (existing) {
      throw new AppError("ALREADY_EXISTS");
    }

    try {
      const [newCategory] = await db //allow when no duplicate
        .insert(productCategory)
        .values(data)
        .returning();

      return newCategory;
    } catch (error: unknown) {
      if (postgresError(error)?.errno === "23505") {
        throw new AppError("ALREADY_EXISTS");
      }
      throw error;
    }
  },

  async update(id: number, data: UpdateCategoryBody) {
    await this.getById(id);

    if (data.categoryName) {
      const [existing] = await db
        .select()
        .from(productCategory)
        .where(eq(productCategory.categoryName, data.categoryName));

      if (existing && existing.categoryId !== id) {
        throw new AppError("ALREADY_EXISTS");
      }
    }

    try {
      const [updatedCategory] = await db
        .update(productCategory)
        .set(data)
        .where(eq(productCategory.categoryId, id))
        .returning();

      return updatedCategory;
    } catch (error: unknown) {
      if (postgresError(error)?.errno === "23505") {
        throw new AppError("ALREADY_EXISTS");
      }
      throw error;
    }
  },

  async remove(id: number) {
    await this.getById(id);

    try {
      const [deletedCategory] = await db
        .delete(productCategory)
        .where(eq(productCategory.categoryId, id))
        .returning();

      return deletedCategory;
    } catch (error: unknown) {
      // Still referenced by product_category_map — the FK is what enforces
      // "in use", so there's no separate pre-check to race against.
      if (postgresError(error)?.errno === "23503") {
        throw new AppError("CATEGORY_IN_USE");
      }
      throw error;
    }
  },
};
