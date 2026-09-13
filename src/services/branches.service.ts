import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { branch } from "@/db/schema";
import { AppError } from "@/utils";
import type {
  CreateBranchBody,
  UpdateBranchBody,
} from "@/models/branches.model";

export const branchesService = {
  async list() {
    return await db.select().from(branch);
  },

  async getById(id: number) {
    const [found] = await db
      .select()
      .from(branch)
      .where(eq(branch.branchId, id));

    if (!found) {
      throw new AppError("NOT_FOUND");
    }
    return found;
  },

  async create(data: CreateBranchBody) {
    const [existing] = await db
      .select()
      .from(branch)
      .where(eq(branch.name, data.name));

    if (existing) {
      throw new AppError("ALREADY_EXISTS");
    }

    try {
      const [created] = await db.insert(branch).values(data).returning();
      return created;
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code === "23505") {
        throw new AppError("ALREADY_EXISTS");
      }
      throw error;
    }
  },

  async update(id: number, data: UpdateBranchBody) {
    await this.getById(id);
    try {
      const [updated] = await db
        .update(branch)
        .set(data)
        .where(eq(branch.branchId, id))
        .returning();
      return updated;
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code === "23505") {
        throw new AppError("ALREADY_EXISTS");
      }
      throw error;
    }
  },

  async deactivate(id: number) {
    await this.getById(id);

    const [updated] = await db
      .update(branch)
      .set({ isActive: false })
      .where(eq(branch.branchId, id))
      .returning();

    return updated;
  },
};
