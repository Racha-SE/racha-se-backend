import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { productCategory } from "@/db/schema";
import { AppError } from "@/utils";
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

    const [newCategory] = await db //allow when no duplicate
      .insert(productCategory)
      .values(data)
      .returning();

    return newCategory;
  },

  async update(id: number, data: UpdateCategoryBody) {
    await this.getById(id);
    if (data.categoryName) {
      const [existing] = await db
        .select()
        .from(productCategory)
        .where(eq(productCategory.categoryName, data.categoryName));

      if (existing && existing.categoryId !== id) {
        //checking duplicate name
        throw new AppError("ALREADY_EXISTS");
      }
    }

    const [updatedCategory] = await db
      .update(productCategory)
      .set(data)
      .where(eq(productCategory.categoryId, id))
      .returning();

    return updatedCategory;
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
      const err = error as {
        code?: string;
        errno?: string | number;
        cause?: {
          code?: string;
          errno?: string | number;
        };
      };
      const errString = JSON.stringify(error);

      const isForeignKeyViolation =
        err?.errno === "23503" ||
        err?.code === "23503" ||
        err?.cause?.errno === "23503" ||
        err?.cause?.code === "23503" ||
        errString.includes("23503") ||
        errString.includes("violates foreign key constraint");

      if (isForeignKeyViolation) {
        throw new AppError("CATEGORY_IN_USE");
      }

      throw error;
    }
  },
};
