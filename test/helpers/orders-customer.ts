import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branch,
  branchOrderDetail,
  customerOrderDetail,
  notification,
  order,
  product,
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

export interface BranchStockInput {
  pId: number;
  /** stock this lot can still hand out — what `create` draws against */
  remain: number;
  expiredDate: Date | null;
  basePrice?: number;
  costPrice?: number;
}

export interface ProductInput {
  costPrice?: number;
  minStockHq?: number;
  minStockBranch?: number;
}

export interface OrdersCustomerFixture {
  branchId: number;
  /** a second branch — proves one branch's stock/orders are invisible to another */
  otherBranchId: number;
  /** userType "cashier" — the one allowed to POST/cancel /orders/customer */
  cashierUser: TestUser;
  /** userType "cashier", but belongs to `otherBranchId` */
  otherBranchCashierUser: TestUser;
  /** userType "branch" — proves list/getById scoping against a non-cashier account */
  branchUser: TestUser;
  /** userType "hq" — proves the route's cross-branch visibility */
  hqUser: TestUser;
  createProduct(input?: number | ProductInput): Promise<number>;
  /** Seeds on-hand branch stock directly (a "completed" branch order + one
   * branchOrderDetail row), bypassing the full request→approve→receive
   * dance — these tests only need the stock to already exist. */
  createBranchStock(
    input: BranchStockInput,
  ): Promise<{ lotId: number; bodId: number }>;
  cleanup(): Promise<void>;
}

/**
 * Seeds the branch/users every customer-order test needs, and hands back
 * factories for the products and branch stock each individual test wants.
 *
 * These run against the real database (same as the rest of this suite), so
 * `cleanup()` deletes exactly what it created and nothing else — `label`
 * only keeps rows readable if a run dies before cleanup.
 */
export async function setupOrdersCustomerFixture(
  label: string,
): Promise<OrdersCustomerFixture> {
  const [createdBranch] = await db
    .insert(branch)
    .values({
      name: `${label} Branch`,
      address: "123 Test Road",
      phoneNumber: "0800000000",
    })
    .returning({ branchId: branch.branchId });

  const [otherCreatedBranch] = await db
    .insert(branch)
    .values({
      name: `${label} Other Branch`,
      address: "456 Test Road",
      phoneNumber: "0800000001",
    })
    .returning({ branchId: branch.branchId });

  const userIds: string[] = [];
  const productIds: number[] = [];

  async function createUser(
    userType: "branch" | "cashier" | "hq",
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
  const cashierUser = await createUser("cashier", createdBranch.branchId);
  const otherBranchCashierUser = await createUser(
    "cashier",
    otherCreatedBranch.branchId,
  );
  const hqUser = await createUser("hq", null);

  return {
    branchId: createdBranch.branchId,
    otherBranchId: otherCreatedBranch.branchId,
    cashierUser,
    otherBranchCashierUser,
    branchUser,
    hqUser,

    async createProduct(input = 0) {
      const {
        costPrice = 0,
        minStockHq = 0,
        minStockBranch = 0,
      } = typeof input === "number" ? { costPrice: input } : input;
      const suffix = crypto.randomUUID();
      const [created] = await db
        .insert(product)
        .values({
          name: `${label} Product ${suffix}`,
          barcode: suffix,
          costPrice,
          minStockHq,
          minStockBranch,
        })
        .returning({ pId: product.pId });
      productIds.push(created.pId);

      return created.pId;
    },

    async createBranchStock({
      pId,
      remain,
      expiredDate,
      basePrice = 0,
      costPrice = 0,
    }) {
      const [createdOrder] = await db
        .insert(order)
        .values({
          orderType: "branch",
          userId: branchUser.id,
          status: "completed",
        })
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
          branchId: createdBranch.branchId,
          pId,
          basePrice,
          costPrice,
        })
        .returning({ bodId: branchOrderDetail.bodId });

      return { lotId: createdOrder.lotId, bodId: createdDetail.bodId };
    },

    async cleanup() {
      // Every order these tests touch is owned by one of the fixture users —
      // the branch lots seeded above (branchUser) and the customer orders the
      // code under test creates (cashierUser) alike — so resolving lot ids
      // off the users covers both without the tests having to report back
      // what they created.
      const lotIds = (
        await db
          .select({ lotId: order.lotId })
          .from(order)
          .where(inArray(order.userId, userIds))
      ).map(({ lotId }) => lotId);

      if (productIds.length > 0) {
        await db
          .delete(notification)
          .where(inArray(notification.pId, productIds));
      }

      if (lotIds.length > 0) {
        // customerOrderDetail references branchOrderDetail.bodId, so it has
        // to go first.
        await db
          .delete(customerOrderDetail)
          .where(inArray(customerOrderDetail.lotId, lotIds));
        await db
          .delete(branchOrderDetail)
          .where(inArray(branchOrderDetail.lotId, lotIds));
        await db.delete(order).where(inArray(order.lotId, lotIds));
      }

      // order rows have to be gone first: trg_before_user_delete refuses to
      // delete a user who still has order history.
      await db.delete(user).where(inArray(user.id, userIds));

      if (productIds.length > 0) {
        await db.delete(product).where(inArray(product.pId, productIds));
      }

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
