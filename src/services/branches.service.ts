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

    const [created] = await db.insert(branch).values(data).returning();

    return created;
  },

  async update(id: number, data: UpdateBranchBody) {
    // ตรวจสอบว่ามีสาขานี้อยู่จริงไหม (ถ้าไม่เจอจะโยน 404 ออกไป)
    await branchesService.getById(id);
    try {
      const [updated] = await db
        .update(branch)
        .set(data)
        .where(eq(branch.branchId, id))
        .returning();
      return updated;
    } catch (error: unknown) {
      const err = error as { code?: string; errno?: number };
      if (err.errno === 19 || err.code === "23505") {
        throw new AppError("ALREADY_EXISTS");
      }
      throw error;
    }
  },

  async deactivate(id: number) {
    // ตรวจสอบว่ามีสาขานี้อยู่จริงไหม
    await branchesService.getById(id);

    try {
      // เปลี่ยนสถานะ isActive เป็น false ตามที่ระบบ Route ต้องการ
      const [updated] = await db
        .update(branch)
        .set({ isActive: false })
        .where(eq(branch.branchId, id))
        .returning();
      return updated;
    } catch (error: unknown) {
      const err = error as { code?: string; errno?: number };
      if (err.errno === 19 || err.code === "23505") {
        throw new AppError("CATEGORY_IN_USE");
      }
      throw error;
    }
  },
};
