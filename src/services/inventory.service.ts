import { db } from "@/db/client";
import {
  branch,
  product,
  branchOrderDetail,
  headOrderDetail,
} from "@/db/schema";
import { eq, sum, and, lte, isNotNull, sql } from "drizzle-orm";
import { AppError } from "@/utils";

export const inventoryService = {
  // --- HQ Scope ---
  async getHqStock() {
    const items = await db
      .select({
        pId: product.pId,
        productName: product.name,
        barcode: product.barcode,
        totalQuantity: sum(headOrderDetail.remain).mapWith(Number),
      })
      .from(headOrderDetail)
      .innerJoin(product, eq(headOrderDetail.pId, product.pId))
      .groupBy(product.pId, product.name, product.barcode);

    return items;
  },

  async listHqLowStock() {
    const items = await this.getHqStock();
    return items.filter((item) => item.totalQuantity <= 5);
  },

  async listHqNearExpiry() {
    const daysToExpiry = 7;
    // ดึงข้อมูลจาก head_order_detail แทน เพราะฝั่ง HQ เก็บสต็อกเป็นล็อตไว้ที่นี่
    const nearExpiryItems = await db
      .select({
        lotId: headOrderDetail.lotId,
        quantity: headOrderDetail.remain,
        expiredDate: headOrderDetail.expiredDate,
        product: {
          pId: product.pId,
          name: product.name,
          barcode: product.barcode,
        },
      })
      .from(headOrderDetail)
      .innerJoin(product, eq(headOrderDetail.pId, product.pId))
      .where(
        and(
          sql`${headOrderDetail.remain} > 0`,
          isNotNull(headOrderDetail.expiredDate),
          lte(
            headOrderDetail.expiredDate,
            sql`NOW() + INTERVAL '${sql.raw(`${daysToExpiry} days`)}'`,
          ),
        ),
      );

    return nearExpiryItems;
  },

  // --- Branch Scope---

  async getBranchStock(branchId: number) {
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
      .groupBy(branchOrderDetail.branchId, product.pId, product.name, product.barcode);

    return items;
  },

  async listBranchLowStock(branchId: number) {
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

    const items = await this.getBranchStock(branchId);

    return items.filter((item) => item.quantity <= 5);
  },

  async listBranchNearExpiry(branchId: number) {
    // 1. ตรวจสอบสถานะสาขา
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

    // 2. กำหนดระยะเวลาที่ถือว่าใกล้หมดอายุ (เช่น 7 วัน)
    const daysToExpiry = 30;

    // 3. ดึงข้อมูลจาก branchOrderDetail
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
