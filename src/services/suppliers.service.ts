import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { supplier } from "@/db/schema";
import type { Supplier } from "@/models/suppliers.model";
import { AppError } from "@/utils";

export const suppliersService = {
  async list(): Promise<Supplier[]> {
    // Names aren't unique, so supplierId breaks ties — keeps the order stable
    // for a picker list instead of whatever order Postgres happens to return.
    return await db
      .select()
      .from(supplier)
      .orderBy(asc(supplier.name), asc(supplier.supplierId));
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
