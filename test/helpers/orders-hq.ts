import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branch,
  headOrderDetail,
  notification,
  order,
  product,
  supplier,
  user,
} from "@/db/schema";
import { auth } from "@/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A date `days` away from now. HQ line items carry the supplier's expected
 * expiry up front (see orders-hq.model.ts), so every test needs one.
 */
export function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export interface ProductInput {
  /** the HQ threshold a min_stock alert is judged against */
  minStockHq?: number;
  costPrice?: number;
  isActive?: boolean;
}

export interface HqStockInput {
  pId: number;
  /** units still sitting in HQ before the order under test is created */
  remain: number;
  expiredDate?: Date;
}

export interface MinStockNotificationInput {
  pId: number;
  /** omitted = HQ-scoped (branchId null); a branch id scopes it to a branch */
  branchId?: number;
  /** stock when the alert was raised — a snapshot, not a live join */
  quantity?: number;
  isResolved?: boolean;
  resolvedAt?: Date;
}

export type NotificationRow = typeof notification.$inferSelect;

export interface OrdersHqFixture {
  branchId: number;
  supplierId: number;
  /** userType "hq" — the one allowed to POST /orders/hq */
  hqUser: TestUser;
  /** userType "branch" — proves the route's 403 path */
  branchUser: TestUser;
  createProduct(input?: ProductInput): Promise<number>;
  createHqStock(input: HqStockInput): Promise<{ lotId: number }>;
  createMinStockNotification(input: MinStockNotificationInput): Promise<number>;
  /** an "expire" alert, which a restock has no business resolving */
  createExpireNotification(input: {
    pId: number;
    lotId: number;
    quantity?: number;
  }): Promise<number>;
  getNotification(notificationId: number): Promise<NotificationRow>;
  cleanup(): Promise<void>;
}

/**
 * Seeds the branch/supplier/users every HQ-order test needs, and hands back
 * factories for the products, existing HQ stock and open notifications each
 * individual test wants.
 *
 * These run against the real database (same as the rest of this suite), so
 * `cleanup()` deletes exactly what it created and nothing else — `label`
 * only keeps rows readable if a run dies before cleanup.
 */
export async function setupOrdersHqFixture(
  label: string,
): Promise<OrdersHqFixture> {
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
  const notificationIds: number[] = [];

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

  return {
    branchId: createdBranch.branchId,
    supplierId: createdSupplier.supplierId,
    hqUser,
    branchUser,

    async createProduct({
      minStockHq = 0,
      costPrice = 0,
      isActive = true,
    }: ProductInput = {}) {
      const suffix = crypto.randomUUID();
      const [created] = await db
        .insert(product)
        .values({
          name: `${label} Product ${suffix}`,
          barcode: suffix,
          minStockHq,
          costPrice,
          isActive,
        })
        .returning({ pId: product.pId });
      productIds.push(created.pId);

      return created.pId;
    },

    async createHqStock({ pId, remain, expiredDate = daysFromNow(30) }) {
      const [createdOrder] = await db
        .insert(order)
        .values({ orderType: "hq", userId: hqUser.id, status: "approved" })
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
        basePrice: 0,
      });

      return { lotId: createdOrder.lotId };
    },

    async createMinStockNotification({
      pId,
      branchId,
      quantity = 0,
      isResolved = false,
      resolvedAt,
    }) {
      const [created] = await db
        .insert(notification)
        .values({
          type: "min_stock",
          pId,
          branchId: branchId ?? null,
          quantity,
          isResolved,
          resolvedAt: resolvedAt ?? null,
        })
        .returning({ notificationId: notification.notificationId });
      notificationIds.push(created.notificationId);

      return created.notificationId;
    },

    async createExpireNotification({ pId, lotId, quantity = 1 }) {
      const [created] = await db
        .insert(notification)
        .values({
          type: "expire",
          pId,
          quantity,
          // the check constraint makes both mandatory for "expire"
          lotId,
          expiredDate: daysFromNow(7),
        })
        .returning({ notificationId: notification.notificationId });
      notificationIds.push(created.notificationId);

      return created.notificationId;
    },

    async getNotification(notificationId) {
      const [row] = await db
        .select()
        .from(notification)
        .where(eq(notification.notificationId, notificationId));

      return row;
    },

    async cleanup() {
      // notifications first: they reference both product and order.
      if (notificationIds.length > 0) {
        await db
          .delete(notification)
          .where(inArray(notification.notificationId, notificationIds));
      }

      // Every order these tests touch is owned by one of the fixture users —
      // the HQ stock seeded above and the orders the code under test creates
      // alike — so resolving lot ids off the users covers both without the
      // tests having to report back what they created.
      const lotIds = (
        await db
          .select({ lotId: order.lotId })
          .from(order)
          .where(inArray(order.userId, userIds))
      ).map(({ lotId }) => lotId);

      if (lotIds.length > 0) {
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
