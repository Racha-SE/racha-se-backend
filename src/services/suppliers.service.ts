import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { supplier } from "@/db/schema";
import type { Supplier } from "@/models/suppliers.model";
import { AppError } from "@/utils";

export const suppliersService = {
  async list(): Promise<Supplier[]> {
    return await db.select().from(supplier);
  },

  async getById(id: number): Promise<Supplier> {
    const [target] = await db
      .select()
      .from(supplier)
      .where(eq(supplier.supplierId, id));

    if (!target) {
      throw new AppError("NOT_FOUND");
    }
    return target;
  },
};
