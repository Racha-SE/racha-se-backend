import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branch,
  branchOrderDetail,
  customerOrderDetail,
  order,
  product,
  productCategory,
  productCategoryMap,
  user,
} from "@/db/schema";
import { auth } from "@/utils";

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export interface SaleLineInput {
  pId: number;
  quantity: number;
  /** what the branch actually sold one unit for — what revenue is built on */
  unitPrice: number;
}

export interface SaleInput {
  createdAt: Date;
  /** only "completed" counts as a sale; the others prove they're skipped */
  status?: "pending" | "completed" | "rejected";
  /** defaults to the fixture's main branch */
  branchId?: number;
  lines: SaleLineInput[];
}

export interface BranchStockInput {
  pId: number;
  remain: number;
  /** defaults to the fixture's main branch */
  branchId?: number;
  /** defaults to 30 days from now, i.e. not expired */
  expiredDate?: Date | null;
  /** the lot's branch-order status — only "completed" stock is on hand */
  status?: "pending" | "completed";
}

export interface AnalyticsFixture {
  branchId: number;
  /** a second branch — proves `branchId` narrows to one branch's sales */
  otherBranchId: number;
  /** every fixture product is linked to it, so tests can isolate them */
  categoryId: number;
  /** userType "hq" — the only one allowed to read the rankings */
  hqUser: TestUser;
  /** userType "branch" — proves the routes' 403 path */
  branchUser: TestUser;
  createProduct(input?: { isActive?: boolean }): Promise<number>;
  /** One branch lot, as if HQ had filled a branch request for it. */
  createBranchStock(
    input: BranchStockInput,
  ): Promise<{ lotId: number; bodId: number }>;
  /** One customer order with its lines, as the POS would have stored it. */
  recordSale(input: SaleInput): Promise<{ lotId: number }>;
  cleanup(): Promise<void>;
}

/**
 * Seeds the branches/category/users the analytics tests need, and hands back
 * factories for products and customer orders.
 *
 * Sales are inserted straight into `order`/`customer_order_detail` with an
 * explicit `createdAt`, so a test can put them in a window nothing else in
 * the shared database falls into. These run against the real database (same
 * as the rest of this suite), so `cleanup()` deletes exactly what it created.
 */
export async function setupAnalyticsFixture(
  label: string,
): Promise<AnalyticsFixture> {
  const [createdBranch, otherCreatedBranch] = await db
    .insert(branch)
    .values([
      {
        name: `${label} Branch ${crypto.randomUUID()}`,
        address: "123 Test Road",
        phoneNumber: "0800000000",
      },
      {
        name: `${label} Other Branch ${crypto.randomUUID()}`,
        address: "456 Test Road",
        phoneNumber: "0800000001",
      },
    ])
    .returning({ branchId: branch.branchId });

  const [createdCategory] = await db
    .insert(productCategory)
    .values({ categoryName: `${label} Category ${crypto.randomUUID()}` })
    .returning({ categoryId: productCategory.categoryId });

  const userIds: string[] = [];
  const productIds: number[] = [];

  async function createUser(
    userType: "branch" | "hq",
    branchId: number | null,
  ): Promise<TestUser> {
    const suffix = crypto.randomUUID();
    const email = `${label}-${userType}-${suffix}@example.com`;
    const password = "password123";

    const result = await auth.api.createUser({
      body: {
        email,
        password,
        name: `${label} ${userType}`,
        data: {
          userType,
          firstname: label,
          lastname: userType,
          username: `${label}-${userType}-${suffix}`,
          branchId,
        },
      },
    });
    userIds.push(result.user.id);

    return { id: result.user.id, email, password };
  }

  const hqUser = await createUser("hq", null);
  const branchUser = await createUser("branch", createdBranch.branchId);

  async function createBranchStock({
    pId,
    remain,
    branchId = createdBranch.branchId,
    expiredDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    status = "completed",
  }: BranchStockInput) {
    const [createdOrder] = await db
      .insert(order)
      .values({ orderType: "branch", userId: branchUser.id, status })
      .returning({ lotId: order.lotId });

    const [createdDetail] = await db
      .insert(branchOrderDetail)
      .values({
        lotId: createdOrder.lotId,
        // nothing has been drawn from a fresh fixture lot, so what the
        // branch received and what's left are the same
        amount: remain,
        remain,
        expiredDate,
        branchId,
        pId,
      })
      .returning({ bodId: branchOrderDetail.bodId });

    return { lotId: createdOrder.lotId, bodId: createdDetail.bodId };
  }

  return {
    branchId: createdBranch.branchId,
    otherBranchId: otherCreatedBranch.branchId,
    categoryId: createdCategory.categoryId,
    hqUser,
    branchUser,

    async createProduct({ isActive = true } = {}) {
      const suffix = crypto.randomUUID();
      const [created] = await db
        .insert(product)
        .values({
          name: `${label} Product ${suffix}`,
          barcode: suffix,
          isActive,
        })
        .returning({ pId: product.pId });
      productIds.push(created.pId);

      await db
        .insert(productCategoryMap)
        .values({ pId: created.pId, categoryId: createdCategory.categoryId });

      return created.pId;
    },

    createBranchStock,

    async recordSale({
      createdAt,
      status = "completed",
      branchId = createdBranch.branchId,
      lines,
    }) {
      // Owned by the branch user: the line's branchId is what analytics reads,
      // the owner only has to be a real user.
      const [createdOrder] = await db
        .insert(order)
        .values({
          orderType: "customer",
          userId: branchUser.id,
          status,
          createdAt,
        })
        .returning({ lotId: order.lotId });

      const expiredDate = new Date(
        createdAt.getTime() + 30 * 24 * 60 * 60 * 1000,
      );

      // Every line has to name the branch lot it was drawn from (bod_id is
      // NOT NULL). The source lot is sold out (remain 0), so recording a sale
      // never leaves stock on hand behind — dead-stock tests seed their own.
      const rows: (typeof customerOrderDetail.$inferInsert)[] = [];
      for (const { pId, quantity, unitPrice } of lines) {
        const { bodId } = await createBranchStock({
          pId,
          remain: 0,
          branchId,
          expiredDate,
        });
        rows.push({
          lotId: createdOrder.lotId,
          pId,
          quantity,
          price: unitPrice,
          branchId,
          bodId,
          expiredDate,
        });
      }
      await db.insert(customerOrderDetail).values(rows);

      return { lotId: createdOrder.lotId };
    },

    async cleanup() {
      // Every order seeded here is owned by a fixture user, so resolving lot
      // ids off the users finds them all.
      const lotIds = (
        await db
          .select({ lotId: order.lotId })
          .from(order)
          .where(inArray(order.userId, userIds))
      ).map(({ lotId }) => lotId);

      if (lotIds.length > 0) {
        // customer_order_detail references branch_order_detail (bod_id), so
        // sales go first, then the lots they drew from, then the orders.
        await db
          .delete(customerOrderDetail)
          .where(inArray(customerOrderDetail.lotId, lotIds));
        await db
          .delete(branchOrderDetail)
          .where(inArray(branchOrderDetail.lotId, lotIds));
        await db.delete(order).where(inArray(order.lotId, lotIds));
      }

      // order rows have to be gone first: trg_before_user_delete (see
      // src/db/migrations/0001_triggers.sql) refuses to delete a user who
      // still has order history. session/account rows cascade off the user.
      await db.delete(user).where(inArray(user.id, userIds));

      if (productIds.length > 0) {
        await db
          .delete(productCategoryMap)
          .where(inArray(productCategoryMap.pId, productIds));
        await db.delete(product).where(inArray(product.pId, productIds));
      }
      await db
        .delete(productCategory)
        .where(
          inArray(productCategory.categoryId, [createdCategory.categoryId]),
        );
      await db
        .delete(branch)
        .where(
          inArray(branch.branchId, [
            createdBranch.branchId,
            otherCreatedBranch.branchId,
          ]),
        );
    },
  };
}
