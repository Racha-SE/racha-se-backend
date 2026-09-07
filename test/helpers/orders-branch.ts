import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branch,
  branchOrderAllocation,
  branchOrderDetail,
  headOrderDetail,
  order,
  product,
  supplier,
  user,
} from "@/db/schema";
import { auth } from "@/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A date `days` away from now — pass a negative number for an expired lot. */
export function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export interface HqLotInput {
  pId: number;
  /** stock this lot can still hand out — what `create` draws against */
  remain: number;
  expiredDate: Date;
  basePrice?: number;
  /**
   * status of the *order* the lot hangs off. Only "approved" lots are
   * drawable, so the other two exist to prove they're skipped.
   */
  status?: "pending" | "approved" | "rejected";
}

export interface OrdersBranchFixture {
  branchId: number;
  supplierId: number;
  /** userType "branch" — the one allowed to POST /orders/branch */
  branchUser: TestUser;
  /** userType "hq" — owns the HQ lots, and proves the route's 403 path */
  hqUser: TestUser;
  createProduct(costPrice?: number): Promise<number>;
  createHqLot(input: HqLotInput): Promise<{ lotId: number }>;
  cleanup(): Promise<void>;
}

/**
 * Seeds the branch/supplier/users every branch-order test needs, and hands
 * back factories for the products and HQ lots each individual test wants.
 *
 * These run against the real database (same as the rest of this suite), so
 * `cleanup()` deletes exactly what it created and nothing else — `label`
 * only keeps rows readable if a run dies before cleanup.
 */
export async function setupOrdersBranchFixture(
  label: string,
): Promise<OrdersBranchFixture> {
  const [createdBranch] = await db
    .insert(branch)
    .values({
      name: `${label} Branch`,
      address: "123 Test Road",
      phoneNumber: "0800000000",
    })
    .returning({ branchId: branch.branchId });

  const [createdSupplier] = await db
    .insert(supplier)
    .values({ name: `${label} Supplier`, contact: "supplier@example.com" })
    .returning({ supplierId: supplier.supplierId });

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

  const branchUser = await createUser("branch", createdBranch.branchId);
  const hqUser = await createUser("hq", null);

  return {
    branchId: createdBranch.branchId,
    supplierId: createdSupplier.supplierId,
    branchUser,
    hqUser,

    async createProduct(costPrice = 0) {
      const suffix = crypto.randomUUID();
      const [created] = await db
        .insert(product)
        .values({
          name: `${label} Product ${suffix}`,
          barcode: suffix,
          costPrice,
        })
        .returning({ pId: product.pId });
      productIds.push(created.pId);

      return created.pId;
    },

    async createHqLot({
      pId,
      remain,
      expiredDate,
      basePrice = 0,
      status = "approved",
    }) {
      const [createdOrder] = await db
        .insert(order)
        .values({ orderType: "hq", userId: hqUser.id, status })
        .returning({ lotId: order.lotId });

      await db.insert(headOrderDetail).values({
        lotId: createdOrder.lotId,
        // nothing has been drawn from a fresh fixture lot, so what HQ
        // received and what's left are the same
        amount: remain,
        remain,
        expiredDate,
        supplierId: createdSupplier.supplierId,
        pId,
        basePrice,
      });

      return { lotId: createdOrder.lotId };
    },

    async cleanup() {
      // Every order these tests touch is owned by one of the fixture users —
      // the HQ lots seeded above and the branch orders the code under test
      // creates alike — so resolving lot ids off the users covers both
      // without the tests having to report back what they created.
      const lotIds = (
        await db
          .select({ lotId: order.lotId })
          .from(order)
          .where(inArray(order.userId, userIds))
      ).map(({ lotId }) => lotId);

      const bodIds = (
        await db
          .select({ bodId: branchOrderDetail.bodId })
          .from(branchOrderDetail)
          .where(inArray(branchOrderDetail.lotId, lotIds))
      ).map(({ bodId }) => bodId);

      if (lotIds.length > 0) {
        await db
          .delete(branchOrderAllocation)
          .where(inArray(branchOrderAllocation.bodId, bodIds));
        await db
          .delete(branchOrderDetail)
          .where(inArray(branchOrderDetail.lotId, lotIds));
        await db
          .delete(headOrderDetail)
          .where(inArray(headOrderDetail.lotId, lotIds));
        await db.delete(order).where(inArray(order.lotId, lotIds));
      }

      // order rows have to be gone first: trg_before_user_delete (see
      // src/db/migrations/0001_triggers.sql) refuses to delete a user who
      // still has order history. session/account rows cascade off the user.
      await db.delete(user).where(inArray(user.id, userIds));

      if (productIds.length > 0) {
        await db.delete(product).where(inArray(product.pId, productIds));
      }
      await db
        .delete(supplier)
        .where(eq(supplier.supplierId, createdSupplier.supplierId));
      await db
        .delete(branch)
        .where(eq(branch.branchId, createdBranch.branchId));
    },
  };
}
